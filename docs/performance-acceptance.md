# Performance acceptance

`coding-tooling performance acceptance [--root <repository>] [--evidence <work evidence>] [--score <runtime-profiler score>] [--json]` reports, for each operation in `.performance/contract.json`, whether it meets its declared acceptance contract. It combines five verdicts, including a user-facing latency deadline. Decision record: [ADR 0002](./adr/0002-controlled-performance-runner.md), owner decisions for issue [#302](https://github.com/moritzbrantner/coding-tooling/issues/302).

## Contract: optional `latency` block

A schemaVersion 2 operation may declare a wall-clock deadline. The schema version is unchanged.

```json
{
  "id": "history-self-score",
  "description": "Score runtime-profiler's own parent-relative history workload.",
  "dimensions": { "runs": {} },
  "scalePoints": [{ "runs": 1 }],
  "latency": {
    "scenario": "runtime-profiler-history-self-score-v1",
    "metric": "process.wall_time",
    "statistic": "p95",
    "maxMs": 8
  }
}
```

- `scenario` names a contract scenario that declares [`controlled.history`](./performance-history.md). That scenario's history filter selects the runtime-profiler entries.
- `metric` is a runtime-profiler metric id, and `statistic` is one of its recorded statistics, such as `median`, `p95` or `mean`.
- `maxMs` is a finite number greater than 0.
- `ratchet` is optional: `informational` (the default) or `blocking`.

An operation with `latency` may leave out `metrics`. Its `dimensions` and `scalePoints` are still required. An operation with neither `metrics` nor `latency` is invalid. An invalid block fails validation with an `operations[<index>].latency` message. Contracts without `latency` validate exactly as before. `performance work` ignores latency-only operations.

## Verdicts

`data.operations[]` lists the operations in contract order as `{ id, verdicts }`. Each verdict has a `state` of `passed`, `failed`, `unavailable`, `not-declared` or `informational`. An `unavailable` verdict carries a `reason`.

| Verdict              | How it is decided                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latency_deadline`   | The recorded `candidate` value of the bound statistic must be at most `maxMs`. The metric's `unit` must be `ms`. `not-declared` without a `latency` block.                                    |
| `historical_ratchet` | The same statistic's `change_percent` (or `score`): a negative change, or a score below 100, is a regression. `informational` unless `ratchet: "blocking"`. `not-declared` without `latency`. |
| `work_growth`        | The `performance work` growth checks of the operation. `not-declared` when it declares no growth bound.                                                                                       |
| `absolute_work`      | The `performance work` budget checks of the operation. `not-declared` when it declares no budget.                                                                                             |
| `functional`         | Always `not-declared`. Operations declare no correctness evidence yet, and nothing is executed.                                                                                               |

`latency_deadline` and `historical_ratchet` carry `metric`, `statistic`, `maxMs` and `source`. `source.kind` is `history` (with the entry's `commit`, `timestamp`, `ref` and `path`) or `score` (with the file `path`). The deadline also carries `value`, and the ratchet carries `changePercent` and `regression`.

## Timing source

By default the timing comes from the bound scenario's runtime-profiler score-history document. It is read from git objects in the same way as [`performance history`](./performance-history.md). Only the newest matching entry by `timestamp` counts. If that entry is not `scored`, or lacks the metric, the statistic, an absolute `candidate` value or an `ms` unit, the deadline is `unavailable`. There is no fallback to an older entry.

`--score <file>` reads a `runtime-profiler/score/v1` document instead. Its `scenario_id` must equal the bound scenario's history filter. A missing or mismatched file is `unavailable`.

coding-tooling reads the recorded statistic as it is. It does not compare fingerprints, digests or runners. A `maxMs` miss fails everywhere, including on GitHub-hosted runners.

Work verdicts use `--evidence`, or the repository's `performance:work` capability command when no file is given, exactly as `performance work` does. They run only when some operation declares work metrics.

## Result

| Status        | Exit | Meaning                                                                                        |
| ------------- | ---- | ---------------------------------------------------------------------------------------------- |
| `passed`      | 0    | No verdict failed or is unavailable.                                                           |
| `failed`      | 1    | A verdict failed, or the contract is missing or invalid. An informational ratchet never fails. |
| `unavailable` | 2    | A verdict is unavailable and none failed.                                                      |

`not-declared` and `informational` verdicts never change the status. `durationMs` is fixed at `0`, so the same inputs always produce a byte-identical report.

## Not covered yet

- Frame pacing, until a real fixture exists.
- Executing `functional` evidence.
