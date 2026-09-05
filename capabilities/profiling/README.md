# Profiling capabilities

Profiling capabilities run repository-declared representative scenarios. `coding-tooling` owns discovery and invocation only; `runtime-profiler` or another declared profiler owns measurement semantics, and repository/evaluator policy owns thresholds and release verdicts.

Stable names:

- `profile:runtime` — bounded runtime evidence for a named workload.
- `profile:hotspots` — source-level sampled CPU/hotspot evidence for a named workload.
- `profile:memory` — memory/resource evidence for a named workload. RSS, retained heap, allocations, and GC metrics remain distinct evidence.

A profiler capability exists only when the repository exposes the corresponding package script or an explicit `capabilityCommands` mapping. Language/framework detection and profiler installation alone are not sufficient.

Unsupported collector environments must remain observable as unavailable or failed evidence from the declared command. Do not replace a requested hotspot or memory collector with ordinary wall-clock timing and call the capability successful.

Profiler capture is opt-in performance work. Baseline/candidate comparison belongs to the evaluator and must preserve scenario and environment comparability rather than being hidden inside these capability names.
