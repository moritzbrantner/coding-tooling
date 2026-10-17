# Controlled performance history

`coding-tooling performance history [--root <repository>] [--json]` reports the controlled wall-clock performance history that a repository keeps for its own scenarios. It reads history only; the comparison itself belongs to `runtime-profiler score`. Decision record: [ADR 0002](./adr/0002-controlled-performance-runner.md) (issue [#158](https://github.com/moritzbrantner/coding-tooling/issues/158)).

## Contract: optional `controlled` block

A scenario in `.performance/contract.json` (schemaVersion 1 or 2, unchanged) may declare where its history lives:

```json
{
  "id": "example-command",
  "kind": "common",
  "description": "Representative command run",
  "dimensions": {},
  "metrics": [
    {
      "name": "wall_time",
      "unit": "ms",
      "direction": "lower",
      "signal": "wall-clock",
      "blocking": false
    }
  ],
  "controlled": {
    "history": { "branch": "score-history", "path": "history.json", "scenario": "example-command" }
  }
}
```

- `branch` is a data-only branch of the same repository, written by the repository's own history workflow (the [`score-history`](./score-history.md) pattern).
- `path` is a repository-relative path on that branch. Absolute paths and `..` segments are rejected.
- `scenario` is the runtime-profiler `scenario_id` to select. It defaults to the contract scenario `id`.

An invalid block fails contract validation with a `scenarios[<index>].controlled` message. Contracts without `controlled` validate exactly as before. The runner and workflow stay per-repository configuration; there is no fleet-wide runner profile.

## Reading

The history document is read from git objects only, never from the working tree. The command tries `refs/remotes/origin/<branch>` first and then `refs/heads/<branch>`, so fetch the branch to see new entries. The document must have `schema_version: "runtime-profiler/score-history/v1"`.

For each scenario that declares `controlled`, in contract order, `data.scenarios[]` reports:

- `id`, `branch`, `path`, `scenario` (the filter) and `ref` (the ref that was read)
- `status`: `available` or `unavailable`, with a `reason` when unavailable
- `entries`: the number of entries that match the filter
- `latest`: the newest matching entry by `timestamp`, as `{ commit, parentCommit, timestamp, classification, score, rating, averageChangePercent, reason? }`

An entry with `status: "scored"` is `comparable`. Any other status is `incomparable` and carries the entry's `reason`. runtime-profiler writes `scenario_id: null` on an entry it could not score, and such an entry matches every filter on that history, so a failed run still shows up as `incomparable`.

A scenario is `unavailable` when the branch is missing, the file is missing on the branch, the JSON is malformed, the `schema_version` is unknown, or no entry matches the filter.

## Classification only, no verification

coding-tooling does not compare `environment_fingerprint`, `scenario_digest` or `workload_digest`, and it does not check runner attestation. Whether two runs are alike is decided by `runtime-profiler score` when it writes the entry. Runner or run metadata in an entry is tolerated and never required. A score below 100 is informational, because historical ratchets are not gates.

## Result

| Status        | Exit | Meaning                                                                       |
| ------------- | ---- | ----------------------------------------------------------------------------- |
| `passed`      | 0    | Every controlled scenario is available. This includes a contract with none.   |
| `unavailable` | 2    | At least one controlled scenario is unavailable. The others are still listed. |
| `failed`      | 1    | The contract is missing or invalid.                                           |

`durationMs` is fixed at `0`, so the same history always produces a byte-identical report.
