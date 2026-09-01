# Repository conformance report

`coding-tooling conformance --json` produces one deterministic, read-only report for the current repository.

The operation composes existing `coding-tooling` mechanics; it does not introduce another policy source or validation engine.

## What it reports

The report has `operation: "conformance"` and `data.reportVersion: 1`. It includes:

- discovered components and technologies;
- whether `.coding-tooling.json` exists and is valid;
- configured/default tier plans, including required and optional missing capabilities;
- availability of executables referenced by planned checks;
- whether `conventions.json`, `conventions.lock.json`, and the installed `.conventions/` snapshot are intact;
- the explicitly selected convention modules;
- results from installed deterministic convention enforcement when the snapshot is valid;
- normalized findings with stable codes, status, severity, and convention ID where known.

## Status semantics

`failed` means a required deterministic contract or installed convention check failed.

`unavailable` means a required prerequisite, capability, component, or executable is unavailable.

Optional missing capabilities are reported as advisory findings and do not make an otherwise clean report fail.

`passed` means no blocking finding was discovered. It is not a claim that unselected convention modules apply or that subjective policy has been proved mechanically.

## Read-only boundary

The report does not install or update conventions, dependencies, toolchains, or repository configuration. It plans declared validation tiers but does not run their repository-owned commands.

Installed convention integrity checking works from the committed manifest, lock, and managed snapshot without a live `coding-agent-conventions` checkout. Deterministic enforcement is executed only from the validated installed snapshot using the existing convention-enforcement path.

Missing configuration is represented as a normal machine-readable finding rather than an exception. This makes the command suitable for landscape aggregation across repositories at different adoption stages.

## Examples

```bash
coding-tooling conformance --json
coding-tooling conformance --config .coding-tooling.json --json
```

Cross-repository traversal, scheduling, remediation, and issue creation remain responsibilities of callers such as `repo-graphs` or an orchestrator.
