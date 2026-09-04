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

## Scope of this slice

This command establishes repository-level graduation evidence only. It does **not** replace the pull-request decision engine. Exact-head refresh, base movement, review blockers, unresolved stack/dependency ordering, policy-changing pull requests, current-head check conclusions, and the final merge action remain responsibilities of the guarded PR integration path and subsequent unattended-merge runner work.
