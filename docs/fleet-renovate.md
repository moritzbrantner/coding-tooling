# Fleet Renovate report

`fleet renovate` is a read-only report on the Renovate setup and backlog of each repository in the fleet.

```sh
coding-tooling fleet renovate --root .. --json
coding-tooling fleet renovate --root .. --repo moritzbrantner/arpg --repo moritzbrantner/scrabble --json
```

It only reads GitHub through `gh`. It never merges, approves, rebases, labels or pushes anything. The result is informational: pending updates, failing Renovate PRs and missing config are reported as `actions`, never as a `failed` status.

## Repositories

With no `--repo`, the report covers the Git repositories directly under `--root`, as enumerated by the [fleet authority graph](./authority-graph.md). Each repository's id comes from the `.repository.toml` `id`. When that is missing, it comes from the `owner/name` in `git config --get remote.origin.url`. Ids are deduplicated, so several worktree checkouts of one repository produce one entry.

The owner-named inactive repositories `moritzbrantner/camunda-workflows` and `moritzbrantner/motion-map` are excluded by default and listed in `data.excluded`; mmorpg is included. GitHub is never queried for it. An explicit `--repo` list replaces fleet enumeration and is taken as given.

## Per-repository entry

- `config`: `present`, `path` and `extendsCentralPreset`. The paths are probed in Renovate's lookup order: `renovate.json`, `renovate.json5`, `.github/renovate.json[5]`, `.gitlab/renovate.json[5]`, `.renovaterc`, `.renovaterc.json[5]`. A config extends the central preset when one `extends` entry is `github>moritzbrantner/coding-agent-conventions` or one of its sub-presets, such as `...:default`. JSON5 is read after stripping comments and trailing commas. If it still does not parse, the preset is matched as a quoted string.
- `app` has one of three values. `installed` means there is an open Dependency Dashboard issue, an open Renovate PR or a `renovate/*` branch. `unknown` means a config is present but there is no Renovate activity. `needs-config` means there is no config and no activity.
- `dashboard`: the Dependency Dashboard issue number, plus its `pendingApproval`, `awaitingSchedule` and `pendingStatusChecks` items as `{ branch, title }`. It also holds `openPrs`, which gives the age in whole days and the check state (`passing`, `failing`, `pending` or `none`) of each open PR authored by Renovate. The dashboard parser ignores unknown sections and the "create/approve all" aggregate lines.
- `actions`: each action has a `kind`, an `owner` flag and a message, plus a `pullRequest` for PR actions. The kinds are:

| Kind                          | Meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `add-config`                  | Add a minimal `renovate.json` that extends the central preset, through the normal PR flow. |
| `extend-central-preset`       | The config exists but does not extend the central preset.                                  |
| `owner-install-app`           | Owner action: check that the Renovate app is installed.                                    |
| `approve-majors-in-dashboard` | Owner action: updates such as majors are waiting for approval in the dashboard.            |
| `fix-failing-renovate-pr`     | A Renovate PR has failing checks.                                                          |
| `stale-pr`                    | A Renovate PR has been open for more than 14 days.                                         |

Updates that are only awaiting their schedule are not an action.

## Status

- `passed` (exit 0) when every selected repository could be read.
- `unavailable` (exit 2) when any GitHub read fails for a reason other than a 404 on a probed config path. The diagnostic names the repository, the repository is listed in `data.unavailable`, and the other repositories are still reported.
