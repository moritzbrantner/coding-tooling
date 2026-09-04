# Fleet merge readiness

`coding-tooling fleet readiness --json` classifies repositories for unattended pull-request integration without weakening `coding-tooling pr integrate`.

The command is deliberately fail-closed. A repository is not inferred to be safe for unattended merging from green CI alone.

## Classifications

- `not-ready` — the deterministic repository foundation is incomplete, merge authority is undeclared, or the hosted authority contract is invalid.
- `local-gated` — authoritative integration remains local. This includes schema-version-2 `cargo.localOnly` source graphs and repositories that explicitly declare local merge authority.
- `protection-required` — the repository declares hosted merge authority, but protected-branch or required-check evidence is missing, incomplete, or unavailable.
- `trusted-auto-merge` — the deterministic foundation passes, hosted authority is explicit, the default branch is verifiably protected, at least one required check is protected, and every declared authoritative check is present in the protected required-check set.

`local-gated` is an intentional safe state, not a degraded form of unattended merging. Those repositories continue through `coding-tooling pr integrate` or an equivalent stronger runner.

## Machine-readable merge authority

Repositories opt into a merge authority explicitly in `.coding-tooling.json`.

Hosted-authoritative example:

```json
{
  "schemaVersion": 1,
  "merge": {
    "authority": "hosted",
    "requiredChecks": ["Validate"]
  }
}
```

Local-authoritative example:

```json
{
  "schemaVersion": 1,
  "merge": {
    "authority": "local",
    "reason": "hardware-bound validation is authoritative"
  }
}
```

A hosted declaration with zero `requiredChecks` is invalid. A local declaration requires a non-empty reason so the guarded boundary is explicit.

A schema-version-2 `.coding-tooling.source-deps.json` with `cargo.localOnly: true` always forces `local-gated`, even if the repository accidentally declares hosted authority. The readiness report emits a deterministic conflict blocker instead of silently weakening the source-development boundary.

## Remote evidence

For hosted-authoritative repositories, the audit uses authenticated GitHub CLI access to read the repository default branch and its protection summary. Missing access, unreadable protection evidence, an unprotected branch, zero required checks, or a mismatch between declared and protected checks all fail closed.

The audit does not use administrator bypass and does not mutate branch protection.

## Pull-request eligibility

Once a repository is `trusted-auto-merge`, the non-mutating pull-request evaluator can establish whether one exact pull-request state is eligible:

```sh
coding-tooling pr eligibility 123 --json
```

A passing result includes a receipt containing the repository, pull-request number, exact head SHA, target branch, exact base SHA, and declared required checks. The evaluator fails closed when any of these conditions is not satisfied:

- the repository is not `trusted-auto-merge`;
- the pull request is closed, draft, non-mergeable, or GitHub does not report a clean merge state;
- zero checks are attached, any attached check is pending or failed, or a declared required check is missing;
- requested changes or required review blocks the pull request;
- unresolved review threads exist or complete review-thread evidence cannot be established;
- the pull request changes merge/validation policy surfaces such as `.coding-tooling.json`, source-dependency policy, validation workflows/actions, dependency-bot policy, or the merge-readiness/PR-integration implementation itself;
- a declared stacked dependency has not already merged;
- the target branch differs from the branch whose protection was verified.

Stack ordering is declared explicitly in the pull-request body with lines such as `Depends on #41`, `Stacked on: #41`, or `After #41`. These declarations are machine-read and must resolve to merged pull requests before unattended eligibility passes.

## Exact-head integration

An eligibility receipt is evidence, not a timeless approval. A runner that is about to mutate repository state must re-run eligibility immediately before integration and bind the decision to the earlier receipt:

```sh
coding-tooling pr eligibility 123 \
  --expected-head <receipt-head-sha> \
  --expected-base <receipt-base-sha> \
  --json
```

If either SHA moved, the second evaluation fails closed. The merge operation must then use GitHub's exact-head precondition for the receipt head and must not use administrative bypass.

`coding-tooling pr eligibility` intentionally does not merge anything. `coding-tooling pr integrate` remains the stronger path for local/source-development/hardware evidence and for policy-sensitive or stacked work that cannot qualify for unattended hosted integration.
