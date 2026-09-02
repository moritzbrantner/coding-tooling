# Detector calibration

`coding-tooling calibration` measures deterministic detector behavior against a repository-owned labeled corpus. The goal is to make detector noise and missed known gaps visible before findings are used for autonomous fixes.

```sh
coding-tooling calibration
coding-tooling calibration --json
```

The command is read-only. Normal repository validation also executes the calibration corpus through the unit-test suite.

## Labels

Each JSON case in `calibration/cases/` selects one detector, one fixture repository, and a complete set of semantic requirements that the case intends to score.

A label has an exact subject and requirement key plus one expected outcome:

- `finding`: the requirement is known to be missing;
- `satisfied`: the requirement is known not to be an active finding;
- `unknown`: the relationship is deliberately unsupported or ambiguous and is excluded from precision/recall scoring.

A `satisfied` label may additionally require an inspectable non-active disposition such as `verified`. This is used for the versioned non-test verification-evidence regression case.

The harness never turns an unlabeled detector emission into a true negative. An active finding that has no label makes the calibration case fail. Duplicate labels are invalid.

## Metrics

For scored labels:

- true positive: expected finding, finding emitted;
- false positive: expected satisfied, finding emitted;
- false negative: expected finding, finding absent;
- true negative: expected satisfied, finding absent;
- unknown: explicitly unscored relationship.

Precision is `TP / (TP + FP)` and recall is `TP / (TP + FN)`. A denominator of zero is represented as `null`, not as an invented 100% score.

Results are reported per detector and in aggregate, but the aggregate is not a universal detector-quality score. Raw counts remain the primary evidence.

## Coverage state

A case can pin the expected detector coverage state (`applied`, `not-applicable`, `unsupported`, or `unavailable`). Coverage mismatches fail the case independently of precision/recall.

`unknown` labels are important for conservative analyzers. For example, a conditionally compiled Rust module remains explicitly unknown rather than being counted as a correct non-finding.

## Initial corpus

The first corpus captures concrete failure modes from findings dogfooding:

- missing TypeScript structural test evidence;
- transitive TypeScript test reachability;
- UI-style versioned non-test verification evidence;
- missing Rust structural test evidence;
- inline Rust test evidence reaching an unconditional module graph;
- conditional Rust module relationships that remain unknown;
- mixed TypeScript/Rust Tauri component boundaries;
- nested `tests/fixtures` package boundaries so fixture manifests cannot silently become product components.

The scoring helper also has deliberate false-positive and false-negative mutations in unit tests. Those tests prove that precision and recall move in the expected direction rather than merely exercising a happy path.

## Autonomous-fix boundary

A detector used to automatically modify repositories should target effectively zero known false positives in the labeled corpus for the relevant contract. High recall is useful, but missed opportunities are safer than autonomous changes driven by known noisy evidence.

Calibration does not prove behavioral correctness and does not replace real consumer dogfood. Real repositories remain necessary for discovering new labels and unsupported cases; once a dogfood outcome is understood, representative cases should be promoted into the calibration corpus so the learning compounds.
