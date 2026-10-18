# Operation work complexity evidence

`coding-tooling performance work --root <repository> [--evidence <file>] --json` verifies deterministic work counters that a repository emits for its own product operations against the upper bounds the repository declares. It never infers Big-O from timings and never picks a class for the repository: the repository declares the bound, and the tool checks the emitted counters at the declared scale points.

Exit codes follow the shared envelope mapping: `0` passed, `1` failed (a bound or budget is violated), `2` unavailable (the contract or evidence cannot establish a result).

## Contract: `.performance/contract.json` schemaVersion 2

Version 2 is version 1 plus optional `operations`. Version 1 contracts remain valid unchanged; a version 1 contract must not carry `operations`, so it cannot be silently half-read. The expectation analysis accepts both versions. See `schemas/performance-contract.schema.json`.

```json
{
  "schemaVersion": 2,
  "suite": "maps/camera",
  "scenarios": [
    {
      "id": "pan-common",
      "kind": "common",
      "description": "Representative pan",
      "dimensions": { "features": 10000 },
      "metrics": [
        {
          "name": "geometry_uploads",
          "unit": "uploads",
          "direction": "lower",
          "signal": "operation-count",
          "blocking": true
        }
      ]
    }
  ],
  "operations": [
    {
      "id": "camera-pan",
      "description": "Pan the camera over unchanged static features.",
      "publicContract": "optional link to a known public-contract surface",
      "dimensions": { "features": { "description": "static features loaded" } },
      "scalePoints": [{ "features": 1000 }, { "features": 10000 }, { "features": 100000 }],
      "metrics": [
        {
          "name": "geometry_uploads",
          "unit": "uploads",
          "signal": "operation-count",
          "budget": { "max": 4 },
          "growth": [{ "dimension": "features", "bound": "constant" }]
        }
      ]
    }
  ]
}
```

`scenarios` keeps its version 1 rules and stays required.

- `dimensions` are named scale dimensions. Each scale point gives one positive integer per dimension, so "vary N with M fixed" and "vary M with N fixed" are both expressible.
- `signal` must be a deterministic counter signal: `operation-count`, `allocation-count`, `instruction-count`, `cache-event-count`, `memory`, `size` or `custom`. `wall-clock` and `throughput` belong to runtime evidence.
- Every metric declares an absolute `budget.max`, growth bounds, or both. A growth bound either names one declared `dimension` with a `bound`, or is a joint `product` of at least two such terms over distinct dimensions (for example O(m · log n)). The class vocabulary is closed:

  | `bound`        | Class                          | Check              |
  | -------------- | ------------------------------ | ------------------ |
  | `constant`     | O(1)                           | exact              |
  | `logarithmic`  | O(log x)                       | tolerant rate test |
  | `linear`       | O(x)                           | exact              |
  | `linearithmic` | O(x log x)                     | tolerant rate test |
  | `quadratic`    | O(x²)                          | tolerant rate test |
  | `cubic`        | O(x³)                          | tolerant rate test |
  | `polynomial`   | O(x^degree · log(x)^logDegree) | tolerant rate test |

  `polynomial` requires an integer `degree` from 1 to 8 and accepts an optional integer `logDegree` from 0 to 8 (default 0); the other classes refuse both fields. The tolerant classes and every product accept an optional `tolerance` from 0 to 4 (default 0.25); `constant` and `linear` are exact and refuse it. A product term cannot be `constant`. A dimension has at most one single-dimension bound per metric, and a metric declares at most one product over the same set of dimensions.

  ```json
  "growth": [
    { "dimension": "bodies", "bound": "logarithmic" },
    { "dimension": "queries", "bound": "linear" },
    { "product": [{ "dimension": "queries", "bound": "linear" }, { "dimension": "bodies", "bound": "logarithmic" }] }
  ]
  ```

- `__proto__`, `constructor` and `prototype` are reserved metric and dimension names, and optional metric `notes` must be a non-empty string.
- A growth bound is refused unless some group of scale points varies its dimensions while holding the other dimensions fixed.
- Free-text strings must contain a non-space character: `suite`, scenario and operation `description`, metric `name` and `unit`, `notes`, `publicContract` and dimension `description`. The shared parser trims these values and refuses whitespace-only ones in both versions, and the published schema expresses the same rule with the pattern `\S`. A growth bound's `dimension` uses the dimension-name pattern. The parser checks version 1 metric `notes` only where a blocking `wall-clock` metric requires them, and does not check `correctnessEvidence` entries or the top-level `description`.

## Growth semantics

Samples are grouped so that each group agrees on every dimension outside the bound (for a product, outside all of its dimensions). Within each group v is the counter (a non-negative integer).

### Exact classes: `constant` and `linear`

The points are ordered by the bounded dimension, x0 < x1 < … < xk:

- `constant`: v(xi) ≤ v(x0) for every i.
- `linear` with three or more points in the group: the per-unit marginal work of every later interval does not exceed the first interval's marginal rate. For every i ≥ 1:

  (v(x[i+1]) − v(x[i])) · (x1 − x0) ≤ max(v(x1) − v(x0), 0) · (x[i+1] − x[i])

  This accepts every affine count a·x + b with a ≥ 0, whatever the sign of b (for example `2N + 7`, `2N − 1` and `5N − 4`), and concave growth. It rejects `N log N`, `N²` and any sequence whose marginal work increases between the declared points. When the first interval is flat or decreasing, the reference rate is 0, so later intervals may only stay flat or decrease.

- `linear` with exactly two points in the group: there is only one interval, so the ratio test v(x1) · x0 ≤ v(x0) · x1 applies. It accepts proportional work and work with a non-negative fixed overhead and rejects super-linear growth between the two points. When v(x0) is 0, it requires v(x1) to be 0.

Comparisons use exact integer arithmetic (BigInt), so products of large counters and scale values do not overflow or round.

### Tolerant classes and products

Every point maps to its model work g = Π x^degree · (1 + log2 x)^logDegree over the bound's terms (the `1 +` keeps g ≥ 1 at x = 1; it only adds lower-order terms). The group is ordered by g, and t is the tolerance:

- Two points: v1 ≤ (1 + t) · v0 · g1 / g0 + 1.
- Three or more points: split the group into a lower and an upper half of ⌈k/2⌉ points each (they share the middle point when the count is odd) and take the least-squares slope dv/dg of each half. The bound holds when

  upper slope ≤ (1 + t) · max(lower slope, 0) + 1 / (g span of the upper half)

  so the upper half may also gain one extra counter unit.

What this accepts and rejects:

- It accepts any affine work a · g + b with a ≥ 0 and b of either sign, and anything that grows more slowly than g. A tree query that visits c nodes per level, for example c · ⌈log2(n / 4)⌉ + 2 on sizes that are not powers of two, passes `logarithmic`. The half-wide least-squares slopes absorb integer steps such as tree levels and rounding, which per-interval tests do not.
- It rejects a class one polynomial degree faster at almost any spread of points. For example, n² against `linearithmic` or n⁴ against `cubic` fail even on five doubling sizes.
- It detects one extra log factor (log² n against `logarithmic`, n² log n against `quadratic`) only when the points span a wide range. Over nine doubling sizes (64 to 16384), such work exceeds the allowed rate by about 12–19%, while honest work stays 15–25% below it. Over narrower ranges, a fractional log excess such as log^1.5 n can pass. Declare geometrically spaced points over at least two to three decades, or lower `tolerance`.

Groups with a single point add no growth check. Exact-class comparisons use exact integer arithmetic (BigInt), so products of large counters and scale values do not overflow or round. A budget is checked at every scale point. Each growth bound and each budget is reported as a separate check `{ metric, kind, dimension?, bound?, max?, state, violations }`, so a regression names the exact metric and dimension. A growth violation names the failing `point` and `value` and the group's smallest point as `baseline` and `baselineValue`; a marginal-rate `linear` violation (three or more points) also names the start of the failing interval as `previous` and `previousValue`. A tolerant-class violation with three or more points names the start of the upper half as `previous` and reports `lowerRate`, `upperRate` and `allowedRate`. Checks for `polynomial` also carry `degree` and `logDegree`, product checks carry `product` (the terms) in place of `dimension` and `bound`, and tolerant checks carry `tolerance`.

The checks cover the declared scale points only. They are executable architectural budgets, not a proof of asymptotic complexity between or beyond those points.

## Evidence: `coding-tooling/work-evidence/v1`

Without `--evidence`, the command runs the `performance:work` capability of the root component that declares it (when several root components declare different commands, the result is unavailable as ambiguous) (a package script or a `capabilityCommands["."]` argv) in the repository root without a shell, and reads the evidence JSON from stdout. With `--evidence`, it reads that file (relative to the current directory) and does not run the collector. See `schemas/work-evidence.schema.json`.

```json
{
  "schemaVersion": "coding-tooling/work-evidence/v1",
  "suite": "maps/camera",
  "contractSha256": "<sha256 of the exact contract bytes>",
  "operations": [
    {
      "id": "camera-pan",
      "samples": [
        { "dimensions": { "features": 1000 }, "metrics": { "geometry_uploads": 3 } },
        { "dimensions": { "features": 10000 }, "metrics": { "geometry_uploads": 3 } },
        { "dimensions": { "features": 100000 }, "metrics": { "geometry_uploads": 3 } }
      ]
    }
  ]
}
```

## Fail-closed rules

The result is `unavailable`, with diagnostics, when any of these holds:

- the contract is missing or invalid, or it declares no operations;
- the collector is not declared, is ambiguous between root components, exits non-zero, is killed, or writes nothing;
- the evidence is not JSON, has another schema version or unknown fields, names another suite, or carries a stale `contractSha256`;
- an operation is missing, undeclared or repeated;
- a scale point is missing, undeclared or repeated;
- a metric is missing, undeclared, or not a non-negative integer. A missing metric is never read as zero.

## Applicability

`performance applicability` reports the `work-complexity` family, backed by the `performance:work` capability, for the repository root component. The family is applicable only when the root contract is schemaVersion 2 and declares at least one operation. With several root components, it belongs to those that expose `performance:work`, or to all of them when none does. A `.performance/applicability.json` entry with `component: "."` matches every root component, but its `work-complexity` wiring is read only for the roots that own the family. The other root components report `not-applicable`. An entry that names a root component explicitly is still read for that component. Every existing contract is validated with the shared parser, so a malformed or unsupported-version contract adds a `performance-contract-invalid` diagnostic. The audit does not decide which product operations matter.

| State                     | Meaning                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `supported`               | A `work-complexity` scenario in `.performance/applicability.json` links `performance:work` and its prerequisites. |
| `applicable-missing`      | Operations are declared but the scenario wiring is absent, or wiring is declared without any operations.          |
| `unsupported-environment` | Wiring exists but a declared tool or platform prerequisite is unavailable.                                        |
| `not-applicable`          | No operations are declared, or the repository records an explicit exception.                                      |

## Ownership

coding-tooling owns the schemas, discovery, invocation and mechanical validation. The repository owns operation semantics, fixtures, counters and budgets. runtime-profiler owns runtime capture, and evaluators own cross-candidate comparison. User-facing latency deadlines are declared as an optional `latency` block on an operation and verified with the work checks by `performance acceptance`; see [performance acceptance](./performance-acceptance.md) (issue #302). Frame pacing is not covered yet. Controlled wall-clock history is read by `performance history`; see [controlled performance history](./performance-history.md).
