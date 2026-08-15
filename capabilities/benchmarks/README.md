# Benchmark capabilities

Executable semantic names:

- `benchmark` — run a declared focused benchmark or runtime-evidence scenario.
- `benchmark:smoke` — run a bounded, inexpensive performance smoke scenario when a repository declares one.

Recognized Bun script candidates include `benchmark`, `bench`, `benchmark:smoke`, and `bench:smoke`. Other ecosystems may declare an explicit adapter without changing the semantic name.

`coding-tooling` does **not** own a baseline/candidate `benchmark:compare` capability. Cross-candidate comparison belongs to an evaluator such as Moonlight. Repository-local benchmark frameworks may still contain their own comparison scripts, but exposing those as a landscape-level semantic comparison capability would duplicate evaluator responsibility.

Where a repository emits the generic benchmark report format, results should satisfy `../../schemas/benchmark-report.schema.json`. Each result records its unit, direction, central value, sample count, environment, and thresholds. Native evidence producers may instead emit their own versioned artifact contracts and expose them to the wider landscape through neutral evidence references.

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
