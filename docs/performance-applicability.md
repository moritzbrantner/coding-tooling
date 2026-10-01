# Performance applicability audit

`coding-tooling performance applicability --root <repository> --json` reports a read-only component audit. `coding-tooling fleet performance --root <fleet-directory> --json` uses the existing fleet authority graph and repository metadata. Active, stable, maintenance and experimental repositories remain visible; retiring/archived repositories are excluded. Missing maintained-status metadata remains visible with a diagnostic rather than silently disappearing.

The v1 report separates four states:

| State                     | Evidence                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supported`               | A repository-owned representative scenario links an available capability command, a regular local source file, and available declared platform/tool prerequisites.        |
| `applicable-missing`      | Shape or an owned workload role indicates applicability, but representative wiring is absent/incomplete. An installed collector or capability name alone is insufficient. |
| `unsupported-environment` | Wiring exists but a declared platform or tool prerequisite is unavailable.                                                                                                |
| `not-applicable`          | No matching shape/workload role, or an explicit repository-owned exception with a reason.                                                                                 |

The envelope reports successful _analysis_, not passing performance. Missing scenarios remain visible even when the audit itself passes. Invalid declarations, unknown selectors, missing/broken scenario paths and unreadable component inputs produce `unavailable`; they cannot establish a green performance result. No components means unresolved applicability, not a zero-case success.

## Initial matrix

| Repository/workload shape                                                                    | Applicable families                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Rust kernels with an explicit role or authored native benches                                | deterministic benchmark smoke, hotspots, memory, distributable size                   |
| React/web                                                                                    | browser audit/trace, runtime, web size; React interactions additionally render budget |
| ASP.NET Web/declared .NET service                                                            | benchmark smoke (e.g. BenchmarkDotNet), runtime (e.g. EventPipe), memory, load smoke  |
| Declared service or recognized Axum/Actix/Warp/Rocket/Express/Fastify/Hono/Koa/Nest boundary | runtime and HTTP load smoke                                                           |
| Expo/React Native                                                                            | startup, frame stalls, runtime memory; collector availability remains explicit        |
| Distributable package/native component                                                       | size budget                                                                           |

Shape-based results are conservative applicability candidates, not product/domain decisions. Framework dependencies and authored benchmarks are structural signals; installation does not imply collector support. Repository owners declare exceptions where a family does not materially apply. Memory metrics remain collector-specific; RSS, allocations and retained heap are not interchangeable. The audit neither measures them nor compares thresholds.

## Owned scenario relationships

Optional `.performance/applicability.json` links the existing capability and scenario authorities. It does not define another benchmark workload, collector protocol or performance contract. Keep the scenario's inputs, bounds, metrics and baselines in its existing owner files.

```json
{
  "schemaVersion": 1,
  "components": [
    {
      "component": ".",
      "roles": ["rust-kernel"],
      "scenarios": [
        {
          "family": "hotspots",
          "capability": "profile:hotspots",
          "path": ".performance/scenarios/physics.yaml",
          "tools": ["runtime-profiler", "perf"],
          "platforms": ["linux"]
        }
      ],
      "notApplicable": [
        { "family": "load-smoke", "reason": "This library exposes no service endpoint." }
      ]
    }
  ]
}
```

Selectors use component name or path, with no conflicting selector matches. Families and roles are closed v1 vocabularies. Duplicate/conflicting family declarations, unknown fields, empty exception reasons, path traversal and symlinked scenarios are refused. Source paths are relative to the repository root; no source content or environment values appear in the report. Scenario and declaration hashes, Git revision/dirty state, platform and architecture retain structural provenance.

Family/capability relationships are explicit: benchmark smoke→`benchmark:smoke`; hotspots→`profile:hotspots`; memory→`profile:memory`; browser audit→`web:audit`; React render budget→`benchmark` or `profile:runtime`; runtime/startup/frame stalls→`profile:runtime`; load smoke→`load:smoke`; size budget→`size:budget`. The load and size implementations remain their separate capability workstreams. A build command cannot masquerade as a runtime collector.

The declared capability is resolved through the normal component/config override machinery. Scenario commands must actually invoke the referenced workload; the read-only audit establishes the owned relationship, not execution or a dynamic call graph. Tools are checked for PATH/file availability without launching them. Exact version compatibility, elevated collector permissions, external devices and backend feature availability still require the declared command's own execution evidence. Never infer successful measurement from `supported` alone.

Derived `.cache`, `.artifacts` and `.asset-tooling` trees cannot create production components. Explicitly selecting a disposable consumer directory as the audit root still inspects that consumer normally. Fixture/generated directories remain data rather than toolchains.

## Reproducibility boundary

These are deterministic lookup commands: no benchmark, profiler, source rewrite, baseline update or generated scaffold runs. Collection remains with runtime-profiler/native tools and policy/verdicts with the repository/evaluator. Missing prerequisites remain observable instead of falling back to wall-clock timing or fabricated benchmarks. The audit publishes no performance score and does not prove architecture or behavioral correctness.
