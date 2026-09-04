# Authenticated pull-request eligibility collection

`coding-tooling pr eligibility` turns the repository readiness contract and current GitHub pull-request state into one fail-closed eligibility result.

```text
coding-tooling pr eligibility <number> \
  --expected-head <validated-head-sha> \
  --expected-base <validated-base-sha> \
  --json
```

The command does not merge, enable auto-merge, modify branch protection, or use administrator bypass.

## Evidence boundary

Repository evidence comes from the same `repositoryMergeReadiness` implementation used by `fleet readiness`. There is no second interpretation of merge authority or required checks.

The authenticated GitHub collector reads:

- current pull-request state and draft state;
- current `headRefOid` and `baseRefOid`;
- mergeability;
- the status-check rollup;
- review decision;
- all review-thread resolved states, with bounded pagination;
- the complete changed-file list;
- the pull request target branch.

The caller supplies the head and base SHAs that were actually validated. Eligibility requires those expected revisions to equal the current GitHub revisions. Omitting either expected revision is blocking.

## Checks

The collector preserves every attached check name and state before passing it to the pure eligibility evaluator. The evaluator requires a nonempty check set, requires every repository-declared authoritative check to be present, and blocks pending, failed, or duplicate ambiguous check evidence.

A zero-check pull request is never green.

## Reviews

All unresolved review threads are conservatively treated as blocking. Review-thread collection follows GitHub pagination up to a bounded 2,000-thread limit. Missing, malformed, or over-limit thread evidence is reported as unavailable rather than being treated as zero.

Requested changes and required-review state remain separate blockers in the pure evaluator.

## Stacks and non-default targets

Repository readiness verifies protection for the repository default branch. Therefore a pull request targeting any other branch is not eligible for unattended integration through this path.

This also fail-closes stacked pull requests whose base is another pull request branch. They must first be reconciled onto the verified default branch after their dependency is merged.

## Integration-policy changes

The collector refuses self-granting policy changes. Generic guarded paths include:

- `.coding-tooling.json`;
- `.coding-tooling.source-deps.json`;
- `.github/workflows/**`;
- `action.yml` / `action.yaml`.

Inside `moritzbrantner/coding-tooling`, the merge-readiness, PR-eligibility, PR-integration, CLI, and entrypoint implementation files are guarded as well.

Changed-file evidence must be complete. If GitHub reports more changed files than the collector received, policy-change evidence is unavailable and eligibility fails closed.

## Runner handoff

A future unattended runner should use this command immediately before mutation with the exact head/base pair that passed its authoritative validation. If the result is not `passed`, it must not merge.

If the result is `passed`, the runner must still perform the merge with an exact-head guard. The mutation layer remains separate so evidence collection can be tested and audited without granting write authority.

`local-gated` repositories never reach this hosted path. They continue through `coding-tooling pr integrate` or an equivalent stronger local runner.
