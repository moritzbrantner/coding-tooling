# Pull-request eligibility collection

`evaluatePullRequestMergeEligibility` is the pure fail-closed decision engine. `coding-tooling pr eligibility` is the GitHub evidence collector that feeds it without mutating repository state.

## Usage

Collect an initial exact-head/base receipt:

```sh
coding-tooling pr eligibility 123 --json
```

Immediately before any unattended mutation, collect again against the earlier receipt:

```sh
coding-tooling pr eligibility 123 \
  --expected-head <receipt-head-sha> \
  --expected-base <receipt-base-sha> \
  --json
```

A moved head or base invalidates the earlier receipt. A future runner must also pass the receipt head to GitHub's exact-head merge precondition and must never use administrator bypass.

## Collector evidence

The collector only runs for repositories already classified `trusted-auto-merge`. It reads the current pull request, current target-branch SHA, check rollup, review threads, declared stack dependencies, and changed-file list, then passes normalized evidence into the shared decision engine.

Collection fails closed when:

- the pull request is closed, draft, or does not have a clean GitHub merge state;
- the target branch differs from the branch whose protection was verified;
- changed-file evidence is missing or truncated relative to GitHub's changed-file count;
- review-thread evidence is missing or requires pagination beyond the collected page;
- declared stack dependencies cannot be read or have not merged;
- repository identity, merge authority, validation workflows/actions, or the merge-readiness/eligibility implementation itself changes in the pull request.

`.repository.toml` is policy-sensitive because it supplies the repository identity used for hosted branch-protection evidence. A pull request cannot point readiness at a different repository and then use that evidence to grant itself eligibility.

Explicit dependency declarations are read from pull-request body lines such as `Depends on #41`, `Stacked on: #41`, and `After #41`.

## Boundary

This command is intentionally read-only. It does not configure branch protection, enable auto-merge, or call `gh pr merge`.

`local-gated` repositories, hardware-bound validation, local-only source graphs, policy-sensitive pull requests, and unresolved stacks remain on `coding-tooling pr integrate` or another equivalent stronger integration path.
