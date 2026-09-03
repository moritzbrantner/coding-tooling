# Repository score

`coding-tooling score` provides a compact 0–100 repository progress signal while retaining the evidence that produced it. The v1 score has two independent pillars:

1. **structural evidence** from deterministic expectation detectors and findings;
2. **verification evidence** from an explicit, fresh `coding-tooling run` report.

This separation is intentional. A repository can be structurally well configured while its actual verification pipeline is red, so the score must not treat “a test command exists” as equivalent to “the tests pass.”

The score is deliberately narrower than a claim of general code quality. It summarizes what the current, versioned `coding-tooling` scoring profile can mechanically observe. Unsupported, unavailable, or not-yet-modeled evidence remains visible instead of silently counting as success or failure.

## Recommended usage

Run the repository validation first and retain its report, even when it fails:

```bash
coding-tooling run \
  --tier fast \
  --strict \
  --report .artifacts/coding-tooling/run.json \
  --json
```

Then score the same repository with that verification evidence:

```bash
coding-tooling score \
  --validation-report .artifacts/coding-tooling/run.json \
  --json
```

`coding-tooling score --json` without a validation report is still useful for inspection. It returns the structural estimate, but marks the result `incomplete` because current execution health was not supplied.

The GitHub Action exposes the same boundary with `operation: score` and the optional `validation-report` input.

## Contract

The command emits `coding-tooling/repository-score/v1` with:

- an overall `score` from 0 to 100 when structural evidence is scoreable;
- `structuralScore` and `verificationScore` so the aggregate never hides its two inputs;
- a Lighthouse-style `rating`: `good` for 90–100, `needs-improvement` for 50–89, and `poor` below 50;
- `complete`, `incomplete`, or `unavailable` evidence state;
- category scores for correctness, testing, automation, maintainability, performance, other applicable evidence, and verification when supplied;
- one structural audit entry per detector, including scan coverage, score subjects, failed score subjects, finding counts, and its individual score;
- a verification summary with the run status, planned/passed/failed/error/blocked check counts, and missing required capabilities;
- explicit modeled/unmodeled detector counts, coverage limitations, and active/suppressed/verified finding counts.

## Structural score

### Scan coverage versus score subjects

Detector scan coverage and score subjects are intentionally separate concepts.

Coverage answers how much input a detector inspected. Score subjects identify the actual requirement units whose satisfaction can move the structural score. Those units depend on the detector:

- source-test, debt-marker, unimplemented-stub, and Rust structural-test audits score source files;
- package test-capability, aggregate-check, TypeScript-config, CLI-wiring, and benchmark-evidence audits score applicable packages;
- required-capability audits score each configured capability;
- Cargo target audits score explicit Cargo targets;
- semantic TypeScript assignability scores analyzed TypeScript projects.

This distinction prevents a package-level failure from being diluted by file count. For example, a package with ten TypeScript files but no test capability has one failed package requirement and therefore scores `0` for that audit; it does not score `90` merely because ten files were scanned.

A detector added in the future does not automatically enter the score. An **applied** detector must define an explicit score-subject model first. Until then the result is marked incomplete or unavailable, making scoring-profile expansion a deliberate contract change. A detector that is not applicable to the repository does not make the score incomplete merely because no score model applies to it.

### Formula

Each modeled detector with at least one applicable score subject is an audit:

```text
audit score = 100 × (score subjects - failed score subjects) / score subjects
```

The structural score is the severity-weighted average of applicable audit scores. Detector default severities use weights `info = 1`, `warning = 2`, and `error = 3`.

This deliberately avoids rewarding configuration changes that merely hide debt:

- baselining a finding does not improve the score;
- suppressing a finding does not improve the score;
- explicit verification evidence attached to a finding can satisfy it because it supplies positive deterministic evidence;
- audits with no applicable score subjects do not enter the numeric denominator;
- unavailable or unsupported detector coverage marks structural evidence `incomplete` rather than treating unknown evidence as `0` or `100`;
- an applied detector without an explicit score-subject model also marks structural evidence incomplete.

## Verification score

The optional validation report must be a schema-v1 `coding-tooling run` report for the same repository root. The score does not rerun or reinterpret the commands; it consumes the explicit execution evidence already produced by the validation operation.

The verification score treats every planned check as an obligation. Checks not reached because an earlier check failed therefore remain unsatisfied rather than disappearing from the denominator. Explicitly missing required capabilities are additional unsatisfied obligations.

```text
verification subjects = planned checks + missing required capabilities
verification score    = 100 × passed checks / verification subjects
```

Failed, errored, and blocked checks contribute no passed credit. Optional missing capabilities do not reduce the score.

This means a four-check validation in which format, lint, and typecheck pass but tests fail scores `75` for verification. If the pipeline stops after lint fails, the later planned checks remain blocked and the verification score reflects that incomplete execution.

## Overall score

When fresh verification evidence is supplied, v1 weights the two pillars equally:

```text
overall score = round((structural score + verification score) / 2)
```

Equal weighting is intentionally simple and inspectable for the first version. It prevents a structurally polished repository from presenting as 100 while its actual verification is red, without inventing per-language or per-project policy thresholds.

When no validation report is supplied, the numeric result remains the structural estimate so the command is still useful during exploration, but `completeness` is `incomplete` and `verificationScore` is `null`.

## Interpretation

The number is most useful as a trend for the same repository and scoring profile. The structural audits, categories, and verification summary explain why it moved.

A score of 100 means all currently modeled structural requirements are satisfied and the supplied verification run passed all planned obligations. It does not mean that the repository is bug-free, secure, semantically correct, sufficiently covered, or fast enough for its product requirements. As `coding-tooling` gains new detectors, score-subject models, or scoring-profile versions, previously invisible gaps can become measurable. Consumers should therefore retain the schema/profile version with historical scores instead of comparing bare numbers across incompatible scoring profiles.

Use `coding-tooling findings --json` for the actionable structural finding stream and retain the validation run report alongside the score for execution evidence.
