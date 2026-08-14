# CLI contract

The CLI is a deterministic interface for humans, CI, coding agents, and higher-level orchestration.

## Commands

```bash
coding-tooling inspect [--json]
coding-tooling check <capability> [--component <name>] [--json]
coding-tooling affected [--base <git-ref>] [--json]
coding-tooling doctor [--json]
coding-tooling plan --tier <name> [--component <name>] [--config <path>] [--json]
coding-tooling run --tier <name> [--component <name>] [--config <path>] [--report <path>] [--strict] [--json]
```

## Stable capability names

```text
format:check
lint
typecheck
build
test
test:unit
test:integration
test:e2e
```

A capability name describes semantics, not an ecosystem command. The implementation maps it to a repository-declared or mechanically safe command.

## JSON envelope

Every command invoked with `--json` returns exactly one JSON object:

```json
{
  "schemaVersion": 1,
  "operation": "check",
  "status": "passed",
  "durationMs": 123,
  "data": {},
  "diagnostics": []
}
```

`status` is one of `passed`, `failed`, `unavailable`, or `error`. A missing capability is not a
passing check, and an environment failure is not a product-code failure.

Exit codes are `0` for passed, `1` for failed, `2` for unavailable or invalid CLI usage, and `3`
for tooling or environment errors. The JSON status remains canonical.

## Discovery and individual checks

`inspect` performs mechanical discovery only. It may inspect repository structure, manifests,
lockfiles, and declared scripts. `check` executes one declared capability without silently mutating
source. `affected` maps a Git baseline to changed files and components. `doctor` reports whether the
deterministic toolchain can operate and never repairs implicitly.

## Plans and runs

`plan` resolves a named validation tier into semantic capability executions without running them.
`run` executes that exact plan and can write the complete result envelope to `--report`.

The optional `.coding-tooling.json` file defines repository tiers, a profile name, required
capabilities, and convention references. It contains no GitHub-specific behavior, so local agent
runs and GitHub Actions execute the same deterministic validation contract.

`--strict` makes unavailable capabilities fail the run. Failed checks and tool errors always fail.

## Boundary with orchestration

This CLI does not create agent runs, retry models, schedule work, choose candidate branches, or own
worktree lifecycle. Those concerns belong to the outer orchestrator.
