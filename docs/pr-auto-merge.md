# Guarded trusted auto-merge activation

`coding-tooling pr auto-merge` is the narrow mutating companion to the read-only `pr eligibility` collector. It does not decide whether a repository or pull request is trusted; it consumes that existing decision and refuses mutation unless the caller presents the exact head/base receipt that was observed earlier.

## Two-phase usage

First collect a read-only receipt:

```sh
coding-tooling pr eligibility 123 --json
```

Take the returned `receipt.headSha` and `receipt.baseSha`, then activate only against those exact values:

```sh
coding-tooling pr auto-merge 123 \
  --expected-head <receipt-head-sha> \
  --expected-base <receipt-base-sha> \
  --json
```

A runner may use `--dry-run` to exercise the complete fresh eligibility check without mutating GitHub state. `--merge-method squash|merge|rebase` selects the ordinary GitHub merge method; `squash` is the default and a required merge queue may override the strategy according to repository policy.

## Safety boundary

Immediately before mutation the command runs `pullRequestMergeEligibility` again with the caller's expected head and base. The existing collector therefore re-reads repository readiness, the pull request, current target-branch SHA, required checks, reviews and review threads, changed files, and declared stack dependencies. Any moved head/base, incomplete evidence, policy-sensitive change, non-green required check, review blocker, unresolved stack dependency, conflict, or loss of `trusted-auto-merge` readiness stops the command before mutation.

After a fresh matching receipt, the only mutation is equivalent to:

```sh
gh pr merge 123 --auto --squash --match-head-commit <fresh-head-sha>
```

The command never uses `--admin`, never weakens branch protection, never changes required checks, and never turns dependency-bot PRs into a special trust class. GitHub remains responsible for protected-branch requirements and merge-queue behavior. A GitHub rejection is returned as a failure and is not retried with a bypass.

`local-gated` repositories remain on `coding-tooling pr integrate`; this command is unavailable until the repository itself has graduated to `trusted-auto-merge`.

## Policy sensitivity

The activation implementation is itself an integration-policy surface. Pull requests changing `src/pr-auto-merge.ts`, the eligibility/readiness implementation, CLI integration, repository identity, validation workflows/actions, or merge-policy configuration cannot use trusted unattended integration to grant their own changes authority.
