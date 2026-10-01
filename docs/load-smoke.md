# Service load smoke

`load:smoke` is an opt-in performance capability for a small representative
service workload. Discovery requires the exact package script or an explicit
`capabilityCommands` mapping. An API framework, an E2E test, a benchmark, a
profiler installation, or a service role alone does not declare a load workload.
Bootstrap adds a declared capability to optional performance work; it does not
require every service to run a generic load command.

The repository owns its deterministic fixture, endpoint selection, methods,
payloads, request count, concurrency, warmup, timeout, and expected statuses.
Use a declared runtime-profiler `http-workload` scenario for native capture and
validation. The profiler owns the HTTP transfer engine and measurement semantics;
coding-tooling invokes the repository command and records its execution status.
There is no HTTP client, scheduling engine, or service-capacity estimate here.

For example, a native service can declare an explicit repository command:

```json
{
  "schemaVersion": 1,
  "optionalCapabilities": ["load:smoke"],
  "tiers": { "performance": ["load:smoke"] },
  "capabilityCommands": {
    ".": { "load:smoke": ["python3", "scripts/load_smoke.py"] }
  }
}
```

```bash
coding-tooling check load:smoke --component . --json
coding-tooling run --tier performance --component . --strict --json
```

The owner wrapper should validate the native scenario, inspect the profiler's
capture plan, and refuse unsupported collectors before starting a fixture. It
then invokes native capture and bundle validation using a new immutable output
directory. Runtime-profiler's HTTP lifecycle assigns a private dynamic loopback
port and cleans up fixture processes and optional external resources. The wrapper
must never substitute a production URL, silently skip a requested collector, or
rewrite a previous bundle. Declare the scenario and native prerequisites in
`.performance/applicability.json` so the structural fleet audit can explain wiring
and availability. That audit does not measure the service.

The `load:smoke` command exit contract is:

| Exit          | Meaning                                                                | coding-tooling status |
| ------------- | ---------------------------------------------------------------------- | --------------------- |
| 0             | Capture, integrity validation, and owner policy completed successfully | passed                |
| 1             | Capture, cleanup, validation, or owner threshold failed                | failed                |
| 2             | Profiler or requested collector is unavailable/unsupported             | unavailable           |
| Other nonzero | Command failed                                                         | failed                |

A missing directly declared executable also reports unavailable. Other launch
errors remain errors. Exit code 2 is reserved for this capability; ordinary lint,
test, and build commands retain their existing nonzero-exit semantics. A selected
but undeclared `load:smoke` workload remains unavailable even when marked optional.
It cannot make a performance-only run green by doing no work.

Keep correctness E2E, broad stress tests, and bounded load evidence separately
invokable. Preserve measured throughput, latency distributions, status/error
rates, and timeout facts in native evidence. Repositories and evaluators own
thresholds and rollout decisions. Shared-runner timings alone are informational;
coding-tooling does not invent service performance budgets.
