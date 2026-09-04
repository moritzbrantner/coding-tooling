# Pull-request merge eligibility

Repository graduation and pull-request eligibility are separate decisions.

`coding-tooling fleet readiness` establishes whether a repository can use hosted unattended integration at all. `evaluatePullRequestMergeEligibility` consumes that repository decision plus a final snapshot of one pull request and fails closed unless the candidate is safe to integrate.

## Required evidence

A candidate is eligible only when all of the following hold:

- repository readiness is `trusted-auto-merge`;
- the repository still has a nonzero authoritative required-check set;
- the current head SHA equals the head SHA that was evaluated;
- the current base SHA equals the base SHA that was evaluated;
- mergeability is known and true;
- attached check evidence is present and nonempty;
- every authoritative required check is attached;
- no attached check is pending or failed;
- check names are unambiguous rather than represented by duplicate conflicting evidence;
- review evidence is present and does not require review or contain requested changes;
- unresolved blocking-review-thread evidence is present and zero;
- stack/dependency evidence is present and unblocked;
- integration-policy-change evidence is present and false.

Missing evidence is a blocker. Unknown is not green.

## Exact-head integration

The future unattended runner must collect this evidence at the final integration boundary, not reuse a stale earlier snapshot. Immediately before mutation it must refresh the pull request and target branch, evaluate the exact current head and base, and merge with an exact-head guard.

A head or base movement invalidates the previous decision and requires a new evaluation. A zero-check state cannot be treated as success.

## Policy-changing pull requests

A pull request that changes merge authority, validation wiring, protected/required-check policy, or the unattended integration mechanism cannot grant itself unattended eligibility. The collector must set `changesIntegrationPolicy: true`, which deterministically blocks this evaluator.

Those changes remain on an explicit reviewed path.

## Local and stacked repositories

`local-gated` repositories remain on `coding-tooling pr integrate` or an equivalent stronger local runner. This includes local-only source-development and hardware-bound validation.

Stacked pull requests remain blocked until their declared dependency order is satisfied. The collector supplies that result as `stackBlocked`; absence of stack evidence is itself blocking.

## Scope

This module is a pure decision engine. It does not query GitHub, change branch protection, enable auto-merge, bypass repository rules, or merge pull requests. Collection and mutation belong to later guarded layers that consume this contract.
