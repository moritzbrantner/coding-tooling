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
coding-tooling conventions init [module...] [--profile <name>] [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
coding-tooling conventions add <module...> [--profile <name>] [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
coding-tooling conventions check [--root <path>] [--json]
coding-tooling conventions diff [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
coding-tooling conventions update [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
coding-tooling conventions resolve [--root <path>] [--config <path>] [--conventions-root <path>] [--registry <path>] [--json]
```

`conventions resolve` is a compatibility command for repositories still using live policy resolution. New consumers should use installed modules.

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
dependencies:audit
benchmark
benchmark:smoke
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

`status` is one of `passed`, `failed`, `unavailable`, or `error`.

Exit codes are `0` for passed, `1` for failed, `2` for unavailable or invalid CLI usage, and `3` for tooling/environment errors.

## Validation commands

`inspect` performs mechanical discovery only.

`check` executes one declared deterministic validation capability and must not silently mutate source code.

`affected` reports facts derived from a Git baseline and repository structure. It does not decide agent policy.

`doctor` diagnoses whether the deterministic toolchain can operate. Repair operations must remain explicit.

`plan` resolves a named validation tier without executing it. `run` executes that plan and may write the full result envelope to `--report`.

The optional `.coding-tooling.json` defines repository validation tiers and explicit capability commands. It should not be used as the primary convention-distribution mechanism for new repositories.

## Installed convention lifecycle

### `conventions init`

Creates `conventions.json` with the selected modules or profile. When the selection is non-empty it also materializes `.conventions/` and `conventions.lock.json`.

The command is idempotent: if the repository is already initialized, it returns the existing selection without overwriting it.

### `conventions add`

Adds modules, resolves their dependencies from `coding-agent-conventions/registry/registry.json`, rematerializes the managed snapshots, and refreshes the lock.

A module selection is explicit. Technology inference is not used to silently change the installed policy set.

### `conventions check`

Works without access to the source registry. It verifies:

- `conventions.json` exists and is valid;
- `conventions.lock.json` exists and is valid;
- the manifest selection matches the lock selection;
- every managed `.conventions/` file matches its recorded SHA-256 hash;
- no unexpected managed files have appeared.

The command does not run formatters, linters, analyzers, tests, or architecture checks. Those remain normal repository capabilities.

### `conventions diff`

Requires access to the current conventions source. It resolves the installed module selection against the current registry and reports changed managed files plus the installed and available registry revisions. It does not mutate the consumer repository.

### `conventions update`

Requires access to the current conventions source. It rematerializes the currently selected modules from the current registry and refreshes `conventions.lock.json`.

Policy updates are therefore deliberate repository changes that can be reviewed like dependency updates.

### Registry source discovery

Commands that need registry content resolve the source checkout in this order:

1. `--conventions-root`;
2. `CODING_AGENT_CONVENTIONS_ROOT`;
3. the `coding-agent-conventions` entry in the shared Moenarch environment registry;
4. a sibling `coding-agent-conventions` checkout.

`conventions check` does not need any of these sources.

## Managed and local policy

`.conventions/` contains managed snapshots and must not be hand-edited.

`.conventions/index.md` is the cheap entry point for humans and agents. It contains a deterministic rule briefing built from each installed `## ID — Title` heading and that rule's first authored bullet, followed by links to the full managed module files. Stable IDs are de-duplicated in the briefing, so detailed documents may expand a rule without repeating it in the hot-path summary.

The briefing is navigation, not a second policy source: its wording is extracted directly from installed convention files, and the full managed source remains authoritative when a rule is relevant or ambiguous.

Repository-specific semantics, commands, architecture boundaries, and deliberate exceptions belong in repository-local guidance such as `AGENTS.md`.

`coding-agent-skills` owns reusable reasoning procedures. Skills may read installed conventions but should not copy policy text.

## Compatibility: `conventions resolve`

The previous live-resolution command remains available during migration. It discovers the current shared checkout, infers technologies, and returns applicable convention files without copying them.

Do not build new repository contracts around live resolution. Migrate consumers to explicit installed modules and remove live-resolution dependencies once the migration is complete.

## Boundary with orchestration

This CLI does not create agent runs, retry models, schedule work, choose candidate branches, or own worktree lifecycle. Those concerns belong to the outer orchestrator.
