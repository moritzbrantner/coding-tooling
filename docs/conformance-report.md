# Repository conformance report

`coding-tooling conformance --json` produces one deterministic, read-only report for the current repository.

The operation composes existing `coding-tooling` mechanics; it does not introduce another policy source or validation engine.

## What it reports

The report has `operation: "conformance"` and `data.reportVersion: 1`. It includes:

- discovered components and technologies;
- repository-environment adoption state in `data.environment`;
- exact native Bun/Rust pins when those toolchains are declared;
- observed local Bun/Rust versions and declared-versus-observed mismatch diagnostics;
- environment-v1 config/script presence and structural validity;
- durable compatibility holds from `.repository-environment.toml`;
- whether `.coding-tooling.json` exists and is valid;
- configured/default tier plans, including required and optional missing capabilities;
- availability of executables referenced by planned checks;
- whether `conventions.json`, `conventions.lock.json`, and the installed `.conventions/` snapshot are intact;
- the explicitly selected convention modules;
- results from installed deterministic convention enforcement when the snapshot is valid;
- normalized findings with stable codes, status, severity, and convention ID where known.

Repositories that have not yet adopted environment-v1 receive an advisory `environment-v1-not-adopted` finding; this does not make an otherwise clean repository fail. A partial or malformed adoption, floating native toolchain pin, missing declared toolchain, or installed-version mismatch is reported separately with a blocking finding.

Compatibility holds are advisory state rather than failures: they mean a newer exact candidate was intentionally rejected after compatibility verification while the repository continues to use its accepted exact pin.

## Status semantics

`failed` means a required deterministic contract or installed convention check failed.

`unavailable` means a required prerequisite, capability, component, executable, or declared toolchain is unavailable.

Advisory findings, including environment-v1 not-yet-adopted and valid compatibility holds, do not make an otherwise clean report fail.

`passed` means no blocking finding was discovered. It is not a claim that unselected convention modules apply or that subjective policy has been proved mechanically.

## Read-only boundary

The report does not install or update conventions, dependencies, toolchains, repository configuration, or compatibility holds. It plans declared validation tiers but does not run their repository-owned commands.

Environment conformance reads only repository-local declarations and locally installed executables. It never queries upstream release services and therefore never decides whether a newer stable toolchain exists. Latest-version discovery and exact-pin mutation belong to the explicit `platform-upgrader refresh latest-stable` path.

Installed convention integrity checking works from the committed manifest, lock, and managed snapshot without a live `coding-agent-conventions` checkout. Deterministic enforcement is executed only from the validated installed snapshot using the existing convention-enforcement path.

Missing configuration is represented as a normal machine-readable finding rather than an exception. This makes the command suitable for landscape aggregation across repositories at different adoption stages.

## Examples

```bash
coding-tooling conformance --json
coding-tooling conformance --config .coding-tooling.json --json
```

Cross-repository traversal, scheduling, freshness discovery, remediation, and issue creation remain responsibilities of callers such as `repo-graphs`, `platform-upgrader`, reusable workflows, or an orchestrator.
