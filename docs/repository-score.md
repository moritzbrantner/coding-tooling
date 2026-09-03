# Repository score

`coding-tooling score --json` turns the deterministic repository finding stream into a compact 0–100 progress signal while retaining the underlying audit evidence.

The score is deliberately narrower than a claim of general code quality. It summarizes what the current, versioned `coding-tooling` detector and scoring profile can mechanically observe. A repository can therefore improve its score as measured gaps are removed, while unsupported, unavailable, or not-yet-modeled analysis remains visible instead of silently counting as success or failure.

## Contract

The command emits `coding-tooling/repository-score/v1` with:

- an overall `score` from 0 to 100 when at least one modeled audit applies;
- a Lighthouse-style `rating`: `good` for 90–100, `needs-improvement` for 50–89, and `poor` below 50;
- `complete`, `incomplete`, or `unavailable` evidence state;
- category scores for correctness, testing, automation, maintainability, performance, and other applicable evidence;
- one audit entry per detector, including scan coverage, score subjects, failed score subjects, finding counts, and the audit score;
- explicit modeled/unmodeled detector counts, coverage limitations, and active/suppressed/verified finding counts.

## Scan coverage versus score subjects

Detector scan coverage and score subjects are intentionally separate concepts.

Coverage answers how much input a detector inspected. Score subjects identify the actual requirement units whose satisfaction can move the score. Those units depend on the detector:

- source-test, debt-marker, unimplemented-stub, and Rust structural-test audits score source files;
- package test-capability, aggregate-check, TypeScript-config, CLI-wiring, and benchmark-evidence audits score applicable packages;
- required-capability audits score each configured capability;
- Cargo target audits score explicit Cargo targets;
- semantic TypeScript assignability scores analyzed TypeScript projects.

This distinction prevents a package-level failure from being diluted by file count. For example, a package with ten TypeScript files but no test capability has one failed package requirement and therefore scores `0` for that audit; it does not score `90` merely because ten files were scanned.

A detector added in the future does not automatically enter the score. It must define an explicit score-subject model first. Until then the result is marked incomplete or unavailable, making scoring-profile expansion a deliberate contract change.

## Formula

Each modeled detector with at least one applicable score subject is an audit. Its score is the percentage of score subjects that have no unresolved finding:

```text
audit score = 100 × (score subjects - failed score subjects) / score subjects
```

The repository score is the severity-weighted average of applicable audit scores. Detector default severities use weights `info = 1`, `warning = 2`, and `error = 3`.

This deliberately avoids rewarding configuration changes that merely hide debt:

- baselining a finding does not improve the score;
- suppressing a finding does not improve the score;
- explicit verification evidence can satisfy a finding because it supplies positive deterministic evidence;
- audits with no applicable score subjects do not enter the numeric denominator;
- unavailable or unsupported detector coverage marks the result `incomplete` rather than treating unknown evidence as `0` or `100`;
- an applied detector without an explicit score-subject model also marks the score incomplete.

## Interpretation

The number is most useful as a trend for the same repository and scoring profile. The audit and category breakdown explains why it moved.

A score of 100 means all currently modeled and applicable score subjects are satisfied. It does not mean that the repository is bug-free, secure, semantically correct, fully tested, or performant. As `coding-tooling` gains new detectors or score-subject models, a newer scoring profile can expose previously invisible gaps. Consumers should therefore retain the schema/profile version with historical scores instead of comparing bare numbers across incompatible scoring profiles.

Use `coding-tooling findings --json` for the actionable finding stream and the coverage evidence behind the score.
