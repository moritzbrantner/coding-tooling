# CLI contract

The CLI is a deterministic interface for humans, CI, coding agents, and higher-level orchestration.

## Commands

```bash
coding-tooling inspect [--json]
coding-tooling check <capability> [--component <name>] [--json]
coding-tooling affected [--base <git-ref>] [--json]
coding-tooling doctor [--json]
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
test:component
storybook:build
test:storybook
test:e2e
audit:lighthouse
benchmark
benchmark:compare
```

A capability name describes semantics, not an ecosystem command. The implementation maps it to a repository-declared or mechanically safe command.

The machine-readable definitions in [`../capabilities/catalog.json`](../capabilities/catalog.json) also declare:

- progressive tier: `fast`, `focused`, `integration`, `system`, or `performance`,
- repository script candidates,
- default failure-artifact paths,
- whether the capability is opt-in,
- whether an explicit baseline is required.

`audit:lighthouse` accepts compatible Lighthouse and Unlighthouse implementations. `benchmark:compare` requires baseline and candidate results that satisfy [`../schemas/benchmark-report.schema.json`](../schemas/benchmark-report.schema.json). Performance budgets satisfy [`../schemas/performance-budget.schema.json`](../schemas/performance-budget.schema.json).

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

`status` is one of:

- `passed`: the requested deterministic operation completed successfully.
- `failed`: the operation ran and found a failing condition.
- `unavailable`: the requested capability is not defined for the selected scope.
- `error`: the operation could not be performed because tooling or the environment failed.

Do not encode `unavailable` as `passed` and do not treat an environment/tool failure as a product-code failure.

## Exit codes

```text
0  passed
1  failed
2  unavailable or invalid CLI usage
3  tooling/environment error
```

The JSON `status` remains the canonical machine-readable meaning; exit codes exist for shell and CI composition.

## `inspect`

`inspect` performs mechanical discovery only. It may inspect repository structure, manifests, lockfiles, declared scripts, and other deterministic metadata.

It must not modify the repository.

Expected `data` fields:

```json
{
  "root": "/repo",
  "technologies": ["typescript", "react", "vite"],
  "components": [
    {
      "name": "frontend",
      "path": ".",
      "kind": "package",
      "technologies": ["typescript", "react", "vite"],
      "capabilities": {
        "lint": ["bun", "run", "lint"]
      }
    }
  ]
}
```

## `check`

`check` executes one declared deterministic validation capability.

A check must not silently mutate source code. Verification capabilities such as `format:check` are separate from future explicit mutation commands.

Expected `data` fields:

```json
{
  "capability": "typecheck",
  "results": [
    {
      "component": "frontend",
      "path": ".",
      "command": ["bun", "run", "typecheck"],
      "status": "passed",
      "exitCode": 0,
      "durationMs": 321
    }
  ]
}
```

## `affected`

`affected` reports facts derived from a Git baseline and repository structure. It does not decide agent policy.

Expected `data` fields:

```json
{
  "base": "HEAD",
  "changedFiles": ["src/example.ts"],
  "affectedComponents": ["frontend"],
  "recommendedCapabilities": ["format:check", "lint", "typecheck", "test:unit"]
}
```

`recommendedCapabilities` is a deterministic mapping from changed scope to available capabilities. The development-loop skill still decides how far validation should progress.

## `doctor`

`doctor` diagnoses whether the deterministic toolchain can operate. It may check repository access, Git state, file permissions, and required runtimes.

Expected `data` fields:

```json
{
  "checks": [
    {
      "name": "git",
      "status": "passed",
      "message": "git is available"
    }
  ]
}
```

`doctor` is diagnostic by default. Any future repair operation must be explicit and separately named; diagnostics must not silently change permissions or configuration.

## Boundary with orchestration

This CLI does not create agent runs, retry models, schedule work, choose candidate branches, or own worktree lifecycle. Those concerns belong to the outer orchestrator.
