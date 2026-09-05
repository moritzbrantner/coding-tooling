# Deterministic remediation candidate plan

`coding-tooling remediation plan --json` turns active deterministic findings into small repository-local work candidates. It is the planning boundary between evidence collection and any later GitHub/agent mutation.

## Defaults

- Only active **new** findings are planned by default.
- Suppressed and verified findings are never emitted as remediation candidates.
- Existing baselined debt is opt-in with `--include-baseline` so automation does not suddenly reopen the entire historical backlog.
- Findings sharing the same deterministic subject are grouped into one candidate rather than becoming one issue or PR per finding.

## Candidate kinds

- `deterministic-scaffold` — every finding in the subject group already exposes a coding-tooling scaffold. The candidate records the existing `coding-tooling scaffold <finding-id>` commands but does not execute them.
- `implementation` — at least one warning/error finding requires implementation or test work beyond the deterministic scaffold surface.
- `review` — the selected subject contains only informational findings and needs a human/agent decision before changing code.

Each candidate carries stable finding IDs, expectation IDs, severity-derived priority, related files, verification commands, available scaffolds, and a deterministic suggested branch name.

## Mutation boundary

The planner is read-only. It does **not** create branches, issues, pull requests, files, suppressions, baselines, or verification declarations. It also does not ask an LLM to invent missing gaps. The authoritative input remains `coding-tooling findings`.

An orchestrator may later select one candidate, create its branch, apply deterministic scaffolds where available, delegate the remaining implementation, run the recorded verification, and open a scoped PR. That later layer must preserve the finding IDs and current evidence so stale or already-resolved candidates can be rejected instead of replayed blindly.

The planner therefore makes automated debt remediation possible without turning finding detection itself into an autonomous code-writing agent.
