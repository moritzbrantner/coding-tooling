# Repository score

`coding-tooling score --json` turns the deterministic repository finding stream into a compact 0–100 progress signal while retaining the underlying audit evidence.

The score is deliberately narrower than a claim of general code quality. It summarizes what the current, versioned `coding-tooling` detector profile can mechanically observe. A repository can therefore improve its score as measured gaps are removed, while unsupported or unavailable analysis remains visible as incomplete coverage rather than silently counting as success or failure.

## Contract

The command emits `coding-tooling/repository-score/v1` with:

- an overall `score` from 0 to 100 when at least one detector applies;
- a Lighthouse-style `rating`: `good` for 90–100, `needs-improvement` for 50–89, and `poor` below 50;
- `complete`, `incomplete`, or `unavailable` coverage state;
- category scores for correctness, testing, automation, maintainability, performance, and other applicable evidence;
- one audit entry per detector, including covered subjects, failed subjects, finding counts, and its individual score;
- the original coverage limitations and active/suppressed/verified finding counts.

## Formula

Each applied detector is an audit. Its score is the percentage of covered subjects that have no unresolved finding:

```text
audit score = 100 × (subjects - failed subjects) / subjects
```

The repository score is the severity-weighted average of applicable audit scores. Detector default severities use weights `info = 1`, `warning = 2`, and `error = 3`.

This deliberately avoids rewarding configuration changes that merely hide debt:

- baselining a finding does not improve the score;
- suppressing a finding does not improve the score;
- explicit verification evidence can satisfy a finding because it supplies positive deterministic evidence;
- unavailable, unsupported, and not-applicable detectors do not enter the numeric denominator;
- unavailable or unsupported coverage marks the result `incomplete` rather than treating unknown evidence as `0` or `100`.

## Interpretation

The number is most useful as a trend for the same repository and scoring profile. The audit and category breakdown explains why it moved.

A score of 100 means all currently applicable detector subjects are satisfied. It does not mean that the repository is bug-free, secure, semantically correct, fully tested, or performant. As `coding-tooling` gains new detectors, a newer scoring profile can expose previously invisible gaps. Consumers should therefore retain the schema/profile version with historical scores instead of comparing bare numbers across incompatible detector sets.

Use `coding-tooling findings --json` for the actionable finding stream and the coverage evidence behind the score.
