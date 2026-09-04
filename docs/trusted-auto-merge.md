# Trusted unattended merge readiness

`coding-tooling` separates repository readiness for unattended integration from the stronger local integration path.

The readiness model is deterministic and fail-closed. It never treats missing GitHub evidence as a pass.

## Repository classifications

`classifyTrustedMergeReadiness` returns one of four machine-readable classifications:

- `not-ready`: the deterministic repository foundation is incomplete, or authoritative hosted validation is missing or unverified;
- `local-gated`: the repository is otherwise ready, but authoritative evidence depends on source-development, hardware, manual, or another explicitly declared local gate;
- `protection-required`: hosted validation is verified, but default-branch protection or a nonzero required-check set is missing or unverified;
- `trusted-auto-merge`: foundation, hosted validation, protected default branch, and a nonzero required-check set are all verified and no local gate applies.

`fleet audit` now exposes this classification as `mergeReadiness`. Local fleet inspection supplies deterministic foundation state and detects `cargo.localOnly` source-development configuration. Authenticated GitHub evidence can be injected by repository ID. Until that remote evidence is supplied, hosted validation and branch protection remain `unknown` rather than being inferred from workflow filenames.

This is intentional: a repository with a workflow file is not automatically a repository with authoritative hosted validation.

## Pull request eligibility

Repository graduation does not make every pull request eligible for unattended integration. `evaluateUnattendedMergeCandidate` separately requires all of the following:

- the repository classification is `trusted-auto-merge`;
- the current head SHA still matches the exact head that was evaluated;
- the current base SHA still matches the evaluated base;
- GitHub reports the pull request as mergeable;
- at least one attached check exists;
- no attached check is pending or failed;
- no requested-changes or review-required state blocks the merge;
- no unresolved blocking review thread remains;
- declared stack/dependency order is satisfied;
- the pull request does not modify merge policy, validation wiring, required-check configuration, or the unattended integration mechanism itself.

A policy-changing pull request therefore cannot grant itself unattended eligibility.

## Local-only and hardware-bound repositories

`coding-tooling pr integrate` remains the stronger integration path for repositories whose authoritative evidence cannot be reproduced by hosted CI. In particular, schema-version-2 source dependency configuration with `cargo.localOnly: true` is reported as the `source-development` local gate.

Do not weaken `pr integrate` merely to make these repositories fit hosted auto-merge. Its synthetic merge, local validation, source-development environment verification, base refresh, and exact-head merge guard remain the correct boundary.

## Remote collection and unattended execution

The readiness model is deliberately pure. The next layer should collect authenticated GitHub evidence for hosted validation, branch protection, required checks, reviews, and the exact current PR/base state, then feed those facts into this model.

The unattended runner must re-read the head and base immediately before merging and must merge using an exact-head guard. It must not use administrator bypass. Repositories should graduate individually rather than enabling fleet-wide dependency-update auto-merge by default.
