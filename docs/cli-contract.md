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

`conventions resolve` provides direct resolution from the current shared convention source. Module-managed consumers use `conventions.json` for explicit module selection and `.conventions/` only as a local cache.

## Stable capability names

```text
format:check
lint
typecheck
build
test
test:unit
test:integration
test:integration:workflow
test:e2e
test:e2e:smoke
test:accessibility
test:visual
package:check
dependencies:audit
benchmark
benchmark:smoke
profile:runtime
profile:hotspots
profile:memory
storybook:check
web:audit
template:smoke
```

A capability name describes semantics, not an ecosystem command. The implementation maps it to a repository-declared or mechanically safe command.

- `test:integration:workflow` verifies multi-operation or business-workflow integration without requiring the browser/full-system boundary of E2E.
- `test:e2e:smoke` is a deliberately small end-to-end critical-path suite, distinct from `test:e2e`.
- `test:accessibility` is deterministic automated accessibility validation; manual review remains separate.
- `test:visual` is deterministic visual-regression or visual-contract validation.
- `package:check` validates package or release shape without publishing.
- `profile:runtime` captures a repository-declared representative runtime scenario.
- `profile:hotspots` captures source-level CPU/hotspot evidence for a repository-declared scenario.
- `profile:memory` captures repository-declared memory/allocation/GC evidence. The capability name does not imply that RSS, retained heap, allocations, or GC pauses are interchangeable.

Profiler capabilities are never inferred merely from a language, framework, or installed profiler executable. They become available only through an explicit repository package script or `capabilityCommands` mapping. `coding-tooling` executes that declaration; the profiler owns measurement semantics and the repository/evaluator owns thresholds. Unsupported collector environments must be surfaced by the declared command as unavailable/failure evidence rather than silently replaced by a weaker measurement.

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

Creates `conventions.json` with the selected modules or profile and materializes `.conventions/` plus `conventions.lock.json`, including an empty managed cache when the selection is empty. The current unpinned lock format is schema v2: it contains cache-integrity metadata and deliberately does not pin a convention source revision. Legacy revision-pinned v1 locks remain readable and are rewritten as v2 on refresh.

The command is idempotent: if the repository is already initialized, it returns the existing selection without overwriting it.

### `conventions add`

Adds modules, resolves their dependencies from the current `coding-agent-conventions/registry/registry.json`, rematerializes the managed cache, and refreshes the lock.

A module selection is explicit. Technology inference is not used to silently change the installed policy set.

Modules may declare explicit companion `assets` and executable `configurations`. Assets are ordinary source-controlled tool-native text files such as JSON, JSONC, TOML, or dotfiles. Executable configuration metadata associates a declared asset with an installed stable rule ID, a supported deterministic tool, and an existing semantic capability.

The installed snapshot contains `.conventions/configurations.json`, which records only the resolved executable metadata for installed modules. It is managed and hashed like every other `.conventions/` file.

### `conventions check`

Works without access to the source registry. It verifies local cache integrity:

- `conventions.json` exists and is valid;
- `conventions.lock.json` exists and is valid;
- the manifest selection matches the lock selection;
- every managed `.conventions/` source, companion asset, and metadata file matches its recorded SHA-256 hash;
- no unexpected managed files have appeared.

The command does not prove convention freshness and does not run formatters, linters, analyzers, tests, or architecture checks. Current policy is resolved from `coding-agent-conventions`; the local cache is not a version authority. Those checks remain normal repository capabilities. Installed executable convention fragments are consumed when those normal capabilities are planned or executed; there is no separate convention-verification capability that callers must remember to add.

### `conventions diff`

Requires access to the current conventions source. It resolves the selected modules against the current registry and reports changed managed files, including companion assets and executable metadata, plus the current source revision for observability. It does not mutate the consumer repository.

### `conventions update`

Requires access to the current conventions source. It rematerializes the currently selected modules, companion assets, and executable metadata from the current registry and refreshes `conventions.lock.json`.

This refresh updates the local cache; it does not opt the repository into a new convention version because convention revisions are not pinned. If current policy exposes an incompatibility, fix the consumer or record a narrow repository-local exception.

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

`.conventions/` contains a managed local cache and must not be hand-edited. Its hashes protect cache integrity; they do not pin the shared policy revision.

`.conventions/index.md` is the cheap entry point for humans and agents. It contains a deterministic rule briefing built from each installed `## ID — Title` heading and that rule's first authored bullet, followed by links to the full managed module files and a separate companion-asset section. Stable IDs are de-duplicated in the briefing, so detailed documents may expand a rule without repeating it in the hot-path summary.

The briefing is navigation, not a second policy source: its wording is extracted directly from cached convention files. The current shared `coding-agent-conventions` source remains authoritative when policy freshness or ambiguity matters.

Repository-specific semantics, commands, architecture boundaries, and deliberate exceptions belong in repository-local guidance such as `AGENTS.md`. Repository tool configuration may add non-conflicting settings, but it may not accidentally override an installed convention requirement through config precedence.

`coding-agent-skills` owns reusable reasoning procedures. Skills may read installed conventions but should not copy policy text.

## Direct current-source resolution: `conventions resolve`

This command discovers the current shared checkout, infers technologies, and returns applicable convention files without copying them. Module-managed repositories should continue to declare their intended module set in `conventions.json`; direct resolution does not replace that explicit selection.

## Boundary with orchestration

This CLI does not create agent runs, retry models, schedule work, choose candidate branches, or own worktree lifecycle. Those concerns belong to the outer orchestrator.
