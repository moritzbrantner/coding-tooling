# Benchmark capabilities

Stable names:

- `benchmark` — run a declared focused benchmark suite and emit machine-readable results.
- `benchmark:compare` — compare baseline and candidate results using committed thresholds.

Recognized Bun script candidates include `bench`, `bench:ci`, and `bench:compare`. Other ecosystems may declare an explicit adapter without changing the semantic name.

Benchmark results must satisfy `../../schemas/benchmark-report.schema.json`. Each result records its unit, direction, central value, sample count, environment, and thresholds. Comparison fails only when both relative and absolute regression limits are exceeded.

Benchmarks are opt-in by default because they are more expensive and hardware-sensitive than focused tests.

## External runtime evidence collectors

`runtime-profiler` is a separate evidence-producing component, not an implementation detail of `coding-tooling`.

Today a consumer repository can invoke a profiler scenario through the existing `capabilityCommands` mechanism while retaining the stable `benchmark` or `benchmark:smoke` semantic capability. For a repository-root component, for example:

```json
{
  "schemaVersion": 1,
  "tiers": {
    "performance": ["benchmark"]
  },
  "capabilityCommands": {
    ".": {
      "benchmark": [
        "runtime-profiler",
        "capture",
        "--scenario",
        "runtime-profile.yaml",
        "--output",
        ".artifacts/runtime-profiler/current"
      ]
    }
  }
}
```

The command remains an argv array and is executed without a shell. Consumer repositories should use a fresh output directory per immutable profiler capture rather than overwriting the illustrative `current` path above.

The responsibility boundary is:

- `coding-tooling` discovers that a deterministic capability exists and invokes the declared command;
- `runtime-profiler` owns scenario validation, capture, normalization, and bundle integrity;
- `agent-contracts` owns the neutral `agent.evidence/v1` reference used across repository boundaries;
- Moonlight or another evaluator owns baseline/candidate comparison and verdicts;
- `coding-agent-conventions` owns policy about when the evidence is required.

`coding-tooling` must not parse profiler internals or silently convert profiler measurements into pass/fail judgments. First-class profiler auto-detection may be added later if it can remain mechanical and does not duplicate profiler semantics.
