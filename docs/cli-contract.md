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

`check` executes one declared deterministic validation capability and must not silently mutate source code. Before executing a supported formatter/linter capability, it also resolves any applicable installed convention configuration fragments and injects their deterministic effective config into the same normal capability command.

`affected` reports facts derived from a Git baseline and repository structure. It does not decide agent policy.

`doctor` diagnoses whether the deterministic toolchain can operate. Repair operations must remain explicit.

`plan` resolves a named validation tier without executing it. `run` executes that plan and may write the full result envelope to `--report`. Both use the same convention-aware capability resolution as `check`.

The optional `.coding-tooling.json` defines repository validation tiers and explicit capability commands. It should not be used as the primary convention-distribution mechanism for new repositories.

## Installed convention lifecycle

### `conventions init`

Creates `conventions.json` with the selected modules or profile and materializes `.conventions/` plus `conventions.lock.json`, including an empty managed snapshot when the selection is empty.

The command is idempotent: if the repository is already initialized, it returns the existing selection without overwriting it.

### `conventions add`

Adds modules, resolves their dependencies from `coding-agent-conventions/registry/registry.json`, rematerializes the managed snapshots, and refreshes the lock.

A module selection is explicit. Technology inference is not used to silently change the installed policy set.

Modules may declare explicit companion `assets` and executable `configurations`. Assets are ordinary source-controlled tool-native text files such as JSON, JSONC, TOML, or dotfiles. Executable configuration metadata associates a declared asset with an installed stable rule ID, a supported deterministic tool, and an existing semantic capability.

The installed snapshot contains `.conventions/configurations.json`, which records only the resolved executable metadata for installed modules. It is managed and hashed like every other `.conventions/` file.

### `conventions check`

Works without access to the source registry. It verifies:

- `conventions.json` exists and is valid;
- `conventions.lock.json` exists and is valid;
- the manifest selection matches the lock selection;
- every managed `.conventions/` source, companion asset, and metadata file matches its recorded SHA-256 hash;
- no unexpected managed files have appeared.

The command does not run formatters, linters, analyzers, tests, or architecture checks. Those remain normal repository capabilities. Installed executable convention fragments are consumed when those normal capabilities are planned or executed; there is no separate convention-verification capability that callers must remember to add.

### `conventions diff`

Requires access to the current conventions source. It resolves the installed module selection against the current registry and reports changed managed files, including companion assets and executable metadata, plus the installed and available registry revisions. It does not mutate the consumer repository.

### `conventions update`

Requires access to the current conventions source. It rematerializes the currently selected modules, companion assets, and executable metadata from the current registry and refreshes `conventions.lock.json`.

Policy updates are therefore deliberate repository changes that can be reviewed like dependency updates.

### Registry source discovery

Commands that need registry content resolve the source checkout in this order:

1. `--conventions-root`;
2. `CODING_AGENT_CONVENTIONS_ROOT`;
3. the `coding-agent-conventions` entry in the shared Moenarch environment registry;
4. a sibling `coding-agent-conventions` checkout.

`conventions check` does not need any of these sources.

## Convention configuration projection

Installed executable fragments are inputs to existing capabilities, not a second execution system.

For each applicable package component and semantic capability, `coding-tooling`:

1. detects the supported tool already selected by the repository-declared capability command or package script;
2. reads the nearest supported repository tool configuration;
3. loads all applicable installed convention fragments for that tool/capability;
4. structurally composes the effective configuration;
5. rejects incompatible settings with `convention-config-conflict` rather than silently weakening policy;
6. writes a deterministic temporary effective config keyed by content hash;
7. invokes the normal capability command with the tool's explicit config-path and nested-config-disable arguments.

The initial adapters are Oxlint for `lint` and Oxfmt for `format:check`. The adapter set is deliberately closed and deterministic; arbitrary shell hooks or a universal convention DSL are out of scope.

A repository with no applicable executable convention fragments receives exactly its previous capability command. A fragment from an uninstalled module cannot apply. If applicable fragments exist but the normal capability does not resolve to exactly one supported tool adapter, capability resolution fails clearly instead of silently ignoring the policy.

Effective configs are transient execution artifacts. They do not modify repository source or the locked `.conventions/` snapshot.

## Managed and local policy

`.conventions/` contains managed snapshots and must not be hand-edited.

`.conventions/index.md` is the cheap entry point for humans and agents. It contains a deterministic rule briefing built from each installed `## ID — Title` heading and that rule's first authored bullet, followed by links to the full managed module files and a separate companion-asset section. Stable IDs are de-duplicated in the briefing, so detailed documents may expand a rule without repeating it in the hot-path summary.

The briefing is navigation, not a second policy source: its wording is extracted directly from installed convention files, and the full managed source remains authoritative when a rule is relevant or ambiguous.

Repository-specific semantics, commands, architecture boundaries, and deliberate exceptions belong in repository-local guidance such as `AGENTS.md`. Repository tool configuration may add non-conflicting settings, but it may not accidentally override an installed convention requirement through config precedence.

`coding-agent-skills` owns reusable reasoning procedures. Skills may read installed conventions but should not copy policy text.

## Compatibility: `conventions resolve`

The previous live-resolution command remains available during migration. It discovers the current shared checkout, infers technologies, and returns applicable convention files without copying them.

Do not build new repository contracts around live resolution. Migrate consumers to explicit installed modules and remove live-resolution dependencies once the migration is complete.

## Boundary with orchestration

This CLI does not create agent runs, retry models, schedule work, choose candidate branches, or own worktree lifecycle. Those concerns belong to the outer orchestrator.
