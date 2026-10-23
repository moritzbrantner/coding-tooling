# Repository conformance report

`coding-tooling conformance --json` produces one deterministic, read-only report for the current repository.

The operation composes existing `coding-tooling` mechanics; it does not introduce another policy source or validation engine.

## What it reports

The report has `operation: "conformance"` and `data.reportVersion: 1`. It includes:

- discovered components and technologies;
- repository-environment adoption state in `data.environment`;
- expected/verified semantic environment fingerprint evidence in `data.environmentFingerprint`;
- declared Bun/Node/Rust versions or channels (any form; declarations are minimums because toolchains track the latest stable release);
- observed local Bun/Node/Rust versions and an advisory `environment-toolchain-behind` diagnostic when an installed release is older than the declared minimum;
- environment-v1 config/script presence and structural validity;
- durable compatibility holds from `.repository-environment.toml`;
- whether `.coding-tooling.json` exists and is valid;
- configured/default tier plans, including required and optional missing capabilities;
- availability of executables referenced by planned checks;
- whether `conventions.json`, `conventions.lock.json`, and the local `.conventions/` cache are intact;
- the explicitly selected convention modules;
- results from installed deterministic convention enforcement when the snapshot is valid;
- normalized findings with stable codes, status, severity, and convention ID where known.

Repositories that have not yet adopted environment-v1 receive an advisory `environment-v1-not-adopted` finding; this does not make an otherwise clean repository fail. A partial or malformed adoption, missing declared toolchain, conflicting Bun declarations, native requirement mismatch, or selected source-profile mismatch is reported separately with a blocking finding. A declared-versus-installed version difference and a loose declaration (`bun@1`, `bun@latest`, `24`, `lts/*`, `stable`) never block: every toolchain tracks the latest stable release.

Compatibility holds are advisory state rather than failures: they record that a specific newer candidate was intentionally rejected after compatibility verification.

## Status semantics

`failed` means a required deterministic contract or installed convention check failed.

`unavailable` means a required prerequisite, capability, component, executable, declared toolchain, or environment verifier is unavailable.

Advisory findings, including environment-v1 not-yet-adopted and valid compatibility holds, do not make an otherwise clean report fail.

`passed` means no blocking finding was discovered. It is not a claim that unselected convention modules apply or that subjective policy has been proved mechanically.

## Read-only boundary

The report does not install or update conventions, dependencies, toolchains, repository configuration, or compatibility holds. It plans declared validation tiers but does not run their repository-owned commands.

Environment conformance reads only repository-local declarations and locally installed executables. Environment fingerprint verification derives expected identity from repository-owned semantic inputs, then observes the current machine; a machine receives `verifiedFingerprint` only when it satisfies that expected identity. Neither path queries upstream release services or decides whether a newer stable toolchain exists. Latest-version discovery and exact-pin mutation belong to the explicit `platform-upgrader refresh latest-stable` path.

Convention cache-integrity checking works from the committed manifest, lock, and managed cache without a live `coding-agent-conventions` checkout. That proves only that the cache has not drifted from its recorded hashes; it does not make the cache a policy-version authority or prove freshness. Current shared policy is resolved from `coding-agent-conventions`, while deterministic enforcement can execute from the validated local cache using the existing convention-enforcement path.

Missing configuration is represented as a normal machine-readable finding rather than an exception. This makes the command suitable for landscape aggregation across repositories at different adoption stages.

## Examples

```bash
coding-tooling conformance --json
coding-tooling conformance --config .coding-tooling.json --json
```

Cross-repository traversal, scheduling, freshness discovery, remediation, and issue creation remain responsibilities of callers such as `repo-graphs`, `platform-upgrader`, reusable workflows, or an orchestrator.
