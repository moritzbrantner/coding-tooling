# Public contract verification

Public-contract verification measures a repository from its externally reachable contract inward. It is deliberately separate from line, branch, and function coverage.

The cross-repository standard is the evidence protocol, not a shared test framework. A repository may use Bun, Vitest, Cargo, Playwright, xUnit, or another implementation underneath the same semantic `coding-tooling` capabilities.

## Commands

```sh
coding-tooling contract discover --json
coding-tooling contract verify --report .artifacts/coding-tooling/public-contract.json --json
```

`discover` does not execute verifier capabilities. `verify` executes each unique `(component, capability)` verifier at most once and reuses that result for every surface mapped to it.

## Discovery

Schema version 1 discovers conservative externally visible boundaries:

- package exports declared by `package.json`;
- CLI binaries declared by `package.json`;
- HTTP operations in JSON OpenAPI documents;
- Rust library crate boundaries;
- .NET project/assembly boundaries;
- root GitHub Actions;
- reusable `workflow_call` workflows.

A surface reports `discovery.status: complete | partial`. Partial discovery is never silently treated as complete. The first schema intentionally reports Rust item APIs, .NET item APIs, CLI subcommands, GitHub Action inputs/outputs, and reusable-workflow inputs/outputs as incomplete until deterministic adapters exist for them.

Zero discovered surfaces are not treated as proof that a repository has no public contract. In that case `verifiedRatio` is `null` and `strictReady` is false. A future explicit no-public-surface proof may make that state distinguishable, but schema version 1 prefers an unknown result over a false 100% score.

## Evidence manifest

Repositories may commit `.coding-tooling.contracts.json`:

```json
{
  "schemaVersion": 1,
  "verifications": [
    {
      "id": "search-endpoint-behavior",
      "surface": "http-operation:POST:%2Fsearch",
      "kind": "behavioral",
      "capability": "test:integration",
      "reason": "The integration suite calls POST /search and asserts the response contract."
    }
  ]
}
```

Evidence points to semantic capabilities rather than framework commands. `coding-tooling` resolves the capability through the repository's existing component model and `.coding-tooling.json` configuration.

Evidence kinds are:

- `behavioral`
- `contract`
- `render`
- `interaction`
- `accessibility`
- `visual`
- `package`
- `compile`
- `reachability`

The protocol validates that an evidence kind is paired with a capability capable of proving that kind. For example, behavioral evidence may use semantic test capabilities but cannot be satisfied by `lint`, formatting, dependency audits, or benchmarks. Package and compile evidence use their corresponding package/build/typecheck capabilities. This keeps native test frameworks behind the capability boundary without allowing arbitrary passing checks to inflate public-contract verification.

`reachability` is recorded but does **not** by itself satisfy public-contract verification. Executing a surface is weaker evidence than asserting or otherwise deterministically verifying its contract.

## Policy

`.coding-tooling.json` owns the small repository policy seam:

```json
{
  "schemaVersion": 1,
  "contracts": {
    "enforcement": "observe",
    "manifest": ".coding-tooling.contracts.json"
  }
}
```

Modes:

- `observe`: measure and report without failing on verification debt.
- `strict`: fail if no public surfaces can be established, any discovered surface is unverified, any discovery remains partial, or mapped verifier evidence fails, is unavailable, or errors.
- `protect-new`: reserved for the base-versus-head contract-diff gate. Schema version 1 reports this mode as unavailable rather than pretending it can enforce it before comparison support exists.

The intended rollout is `observe` -> `protect-new` -> `strict` as detector coverage matures.

## Machine report

The report includes:

- exact Git revision when available;
- discovered, verified, and unverified counts;
- incomplete-discovery count;
- verified ratio, or `null` when no surface was discovered;
- separate failed, unavailable, and error evidence counts;
- strict-readiness;
- every stable surface ID and its evidence;
- explicit unsupported analyzers.

The summary dimensions are not mutually exclusive buckets. A discovered coarse boundary can be verified while its finer-grained discovery remains incomplete, so portfolio consumers should present incomplete discovery alongside the verification ratio rather than folding it into verified/unverified.

Portfolio consumers should read this report instead of recomputing contract semantics. `repo-dashboard` is an aggregator, not a second analyzer.
