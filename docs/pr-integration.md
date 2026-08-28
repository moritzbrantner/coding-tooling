# Local-first pull request integration

`coding-tooling pr integrate <number>` turns the repository's local validation capabilities into a guarded GitHub PR merge workflow.

```bash
coding-tooling pr integrate 42
```

The default behavior is intentionally conservative:

1. Require `git`, GitHub CLI (`gh`), and a clean working tree.
2. Read the open, non-draft PR metadata from GitHub.
3. Fetch the latest target branch and `refs/pull/<number>/head` locally.
4. Detach at the exact PR head and create a temporary local merge with the fetched target revision.
5. Run `coding-tooling`'s `full` validation tier against that synthetic merge.
6. Verify the pipeline did not mutate tracked files.
7. Refresh the PR and target branch.
8. Refuse integration if the PR head or base moved, checks are pending/failing, reviews block the merge, or GitHub no longer reports the PR as mergeable.
9. Restore the original local checkout and remove the temporary ref.
10. Squash-merge through `gh pr merge --match-head-commit` so a changed PR head cannot be merged accidentally.

The local pipeline is authoritative for code verification; GitHub remains the coordination and merge boundary. A race or stale result fails closed and should be handled by rerunning the command rather than merging an older verification result.

## Options

```bash
coding-tooling pr integrate 42 --tier fast
coding-tooling pr integrate 42 --merge-method merge
coding-tooling pr integrate 42 --merge-method rebase
coding-tooling pr integrate 42 --remote upstream
coding-tooling pr integrate 42 --dry-run
coding-tooling pr integrate 42 --json
```

Defaults:

- validation tier: `full`
- merge method: `squash`
- Git remote: `origin`

`--dry-run` performs every fetch, synthetic merge, local check, and remote gate but does not merge.

## Failure behavior

The command does not merge when:

- the starting worktree is dirty;
- the PR is closed or draft;
- the PR cannot be merged locally with the fetched base;
- the local pipeline does not pass;
- the local pipeline mutates tracked files;
- the PR head changes after verification;
- the base branch changes after verification;
- GitHub checks are pending or failing;
- a review requirement blocks the PR;
- GitHub reports the PR as not mergeable;
- restoring the original checkout fails.

This command intentionally does not fix a PR, rebase or push its branch, bypass reviews, use administrator merge privileges, wait for checks, or enable auto-merge. Those are separate actions and should remain explicit.
