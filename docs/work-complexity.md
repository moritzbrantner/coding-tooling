# Operation work complexity evidence

`coding-tooling performance work --root <repository> [--evidence <file>] --json` verifies deterministic work counters that a repository emits for its own product operations against the upper bounds the repository declares. It never infers Big-O from timings and never fits curves: the repository declares the bound, and the tool checks the emitted counters at the declared scale points.

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
- Every metric declares an absolute `budget.max`, growth bounds, or both. Each growth bound names exactly one declared dimension. The growth vocabulary is closed: `constant` and `linear`.
- A growth bound is refused unless some group of scale points varies its dimension while holding the other dimensions fixed.

## Growth semantics

Samples are grouped so that each group agrees on every dimension except the bounded one. Within each group, x0 is the smallest value of the bounded dimension and v(x) is the counter:

- `constant`: v(x) ≤ v(x0).
- `linear`: v(x) · x0 ≤ v(x0) · x. This accepts proportional work with a fixed overhead (for example `2N + 7`) and rejects `N log N` and `N²` growth between the declared points.

When v(x0) is 0, a `linear` bound therefore requires 0 at every larger point of the group. Groups with a single point add no growth check. Comparisons use exact integer arithmetic. A budget is checked at every scale point. Each growth bound and each budget is reported as a separate check `{ metric, kind, dimension?, bound?, max?, state, violations }`, so a regression names the exact metric and dimension.

The checks cover the declared scale points only. They are executable architectural budgets, not a proof of asymptotic complexity between or beyond those points.

## Evidence: `coding-tooling/work-evidence/v1`

Without `--evidence`, the command runs the root component's `performance:work` capability (a package script or a `capabilityCommands["."]` argv) in the repository root without a shell, and reads the evidence JSON from stdout. With `--evidence`, it reads that file (relative to the current directory) and does not run the collector. See `schemas/work-evidence.schema.json`.

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
- the collector is not declared, exits non-zero, is killed, or writes nothing;
- the evidence is not JSON, has another schema version or unknown fields, names another suite, or carries a stale `contractSha256`;
- an operation is missing, undeclared or repeated;
- a scale point is missing, undeclared or repeated;
- a metric is missing, undeclared, or not a non-negative integer. A missing metric is never read as zero.

## Applicability

`performance applicability` reports the `work-complexity` family, backed by the `performance:work` capability, for the repository root component. The family is applicable only when the root contract is schemaVersion 2 and declares at least one operation. The audit does not decide which product operations matter.

| State                     | Meaning                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `supported`               | A `work-complexity` scenario in `.performance/applicability.json` links `performance:work` and its prerequisites. |
| `applicable-missing`      | Operations are declared but the scenario wiring is absent, or wiring is declared without any operations.          |
| `unsupported-environment` | Wiring exists but a declared tool or platform prerequisite is unavailable.                                        |
| `not-applicable`          | No operations are declared, or the repository records an explicit exception.                                      |

## Ownership

coding-tooling owns the schemas, discovery, invocation and mechanical validation. The repository owns operation semantics, fixtures, counters and budgets. runtime-profiler owns runtime capture, and evaluators own cross-candidate comparison. User-facing latency and frame-deadline acceptance is separate (issue #302).
