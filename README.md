# coding-tooling

Deterministic repository tooling for humans, CI, and coding agents.

This repository contains mechanical operations that should not require an LLM to rediscover or reinterpret them on every task.

## Responsibility boundary

`coding-tooling` answers questions such as:

- What kind of repository/components are present?
- Which validation capabilities are available?
- Which files/components changed relative to a baseline?
- How do I run a declared validation capability?
- Which convention modules are installed and are their managed snapshots intact?
- Which installed convention rules have deterministic tool configuration, and how is that configuration projected into the normal capability that enforces them?
- Is the local environment able to run declared capabilities?
- Which exact source revisions should temporarily replace registry packages during cross-repository development?

It deliberately does **not** decide what task to implement, how an agent should reason, what engineering policy should be, or whether one implementation is semantically preferable. Those concerns belong to callers, `coding-agent-skills`, `coding-agent-conventions`, orchestration, and evaluation respectively.

## Commands

```bash
coding-tooling inspect [--json]
coding-tooling check <capability> [--component <name>] [--json]
coding-tooling affected [--base <git-ref>] [--json]
coding-tooling doctor [--json]
coding-tooling plan --tier fast [--json]
coding-tooling run --tier fast --report .artifacts/coding-tooling/report.json --strict --json
coding-tooling source-deps activate [--config <path>] [--json]
coding-tooling source-deps status [--config <path>] [--json]
coding-tooling source-deps deactivate [--config <path>] [--json]
coding-tooling agent-capabilities validate [--root <path>] [--json]
coding-tooling agent-capabilities catalog [--root <path>] [--json]
coding-tooling agent-capabilities profile <profile> [--root <path>] [--json]
coding-tooling conventions init [module...] [--profile <name>] [--json]
coding-tooling conventions add <module...> [--profile <name>] [--json]
coding-tooling conventions check [--json]
coding-tooling conventions diff [--json]
coding-tooling conventions update [--json]
```

`coding-tooling conventions resolve` remains temporarily available for repositories still using the previous live-resolution contract.

Run directly during development with Bun:

```bash
bun src/cli.ts inspect --json
```

## Installed conventions

Shared engineering policy is authored in `coding-agent-conventions`, but consumer repositories explicitly install only the modules they use.

```bash
coding-tooling conventions init react testing-library vitest
```

or with a registry profile:

```bash
coding-tooling conventions init --profile react-app
```

This creates:

```text
conventions.json
conventions.lock.json
.conventions/
  index.md
  configurations.json
  modules/
```

`conventions.json` is the human-owned selection. `conventions.lock.json` records the resolved dependency set, source revision, and content hashes. `.conventions/` contains managed snapshots that agents and deterministic tooling can consume without network access or a shared conventions checkout.

Do not hand-edit `.conventions/`. Repository-specific policy and exceptions belong in `AGENTS.md`.

### Companion tooling configuration

A convention module may include explicit tool-native companion assets, such as an Oxlint or Oxfmt JSON fragment. The registry associates each executable fragment with a stable rule ID, a supported tool, and an existing semantic capability.

For example, the TypeScript convention `TS-003 — Prefer type over interface` can ship an Oxlint fragment that requires `typescript/consistent-type-definitions` with the `type` option. Installing the TypeScript module vendors and hashes that fragment. There is no separate convention-only verification command: normal `lint` resolution composes the repository's Oxlint config with the installed convention requirement and invokes the existing lint command with the resulting explicit config.

The same seam applies to `format:check` for Oxfmt fragments. Hooks, CI, agents, or local workflows that delegate to `coding-tooling` semantic capabilities therefore inherit deterministic convention enforcement automatically.

Composition is structural and conservative:

- repository configuration may add unrelated settings;
- installed convention requirements cannot be silently disabled or weakened;
- incompatible values produce a deterministic `convention-config-conflict` instead of relying on config precedence;
- fragments from modules that are not installed do not apply;
- repositories without executable convention fragments retain their previous capability commands unchanged.

Effective merged configs are generated as deterministic temporary artifacts and passed through the supported tool's explicit config-path option. They are not another human-authored policy source and do not change the locked `.conventions/` snapshot.

Some installed rules include small JSON enforcement sidecars authored next to the convention. `coding-tooling run` consumes those descriptors before repository validation commands. It can run focused Oxlint or Clippy checks, perform a small set of structural checks, or require a semantic capability for a validation tier. The rule semantics remain owned by `coding-agent-conventions`; `coding-tooling` only executes the declared deterministic mechanism.

Validation is fail-fast: convention checks and tier capabilities run in deterministic order and stop after the first failure or unavailable required enforcement. This makes the cheap-before-expensive validation policy executable rather than advisory.

### Updating policy

Convention policy does not silently change underneath a repository. Inspect and deliberately accept updates:

```bash
coding-tooling conventions diff
coding-tooling conventions update
```

`diff` compares the installed snapshots with the current registry source without mutating the repository. `update` rematerializes the selected modules and refreshes the lock.

### Checking policy installation

```bash
coding-tooling conventions check
```

The check is intentionally narrow. It verifies the manifest/lock relationship and detects drift in managed convention files, including companion assets and their installed configuration metadata. It does **not** run formatters, linters, analyzers, tests, architecture checks, convention enforcement, or the repository's normal CI commands. Those checks remain the normal semantic capabilities; when they are executed, applicable convention configuration is composed automatically, and `coding-tooling run` performs executable enforcement as part of validation.

Commands that need registry content (`init`, `add`, `diff`, `update`) discover `coding-agent-conventions` from an explicit `--conventions-root`, `CODING_AGENT_CONVENTIONS_ROOT`, the shared Moenarch environment registry, or a sibling checkout. `check` needs only the committed consumer files and therefore works offline.

## Source development mode

Cross-repository feature work should not require publishing intermediate Cargo packages. A consumer can commit `.coding-tooling.source-deps.json` with exact source revisions and use `source-deps activate` to materialize a managed local `.cargo/config.toml` containing Cargo source patches.

The declaration may include a sibling checkout path. When that checkout exists, coding-tooling verifies its Git `HEAD` against the declared revision before using it. Otherwise it emits an exact Git-revision patch. `deactivate` removes only configurations generated by coding-tooling and refuses to touch unrelated Cargo configuration.

Source mode proves a development graph. Release verification remains separate and must deactivate source overrides before proving registry-only resolution. See `docs/source-development-mode.md`.

## Capabilities

Capabilities are stable semantic names; concrete commands are repository-specific.

Current names:

```text
format:check
lint
typecheck
build
test
test:unit
test:integration
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

- `test:e2e:smoke` checks a deliberately small end-to-end suite for critical paths; it is separate from a full `test:e2e` suite.
- `test:accessibility` runs deterministic automated accessibility checks. It does not replace manual accessibility review.
- `test:visual` runs deterministic visual-regression or visual-contract checks.
- `package:check` validates the package or release shape without publishing, such as metadata, a pack dry-run, or an API/package surface check.
- `profile:runtime` invokes a repository-declared representative runtime scenario.
- `profile:hotspots` invokes a repository-declared source-level CPU/hotspot scenario.
- `profile:memory` invokes repository-declared memory/resource evidence; it does not collapse RSS, retained heap, allocations, or GC into one metric.

For JavaScript/TypeScript components, declared package scripts are preferred over invented commands. When an installed convention has an applicable supported tool fragment, `coding-tooling` preserves that normal semantic capability but injects the deterministic effective config into the selected formatter/linter invocation. Rust and .NET use conservative built-in commands where semantics are mechanically clear.

External deterministic tools may be wired through `capabilityCommands`. `coding-tooling` invokes the declared command but does not own the external tool's policy semantics; applicable convention fragments still have to match a supported deterministic adapter before they can be enforced.

Profiler capabilities are intentionally stricter about discovery than ordinary ecosystem defaults: a language/framework or installed profiler executable does not make profiling available. The repository must declare the scenario through a package script or `capabilityCommands`. This keeps missing or unsupported collector evidence visible instead of inventing a generic profile command that measures no representative workload.

The convention-backed gate capabilities deliberately use canonical repository scripts: `storybook:check`, `web:audit`, and `template:smoke`. A module that installs the corresponding convention can make that capability required for its full validation tier without embedding Storybook, Lighthouse, or template-specific orchestration inside coding-tooling.

External deterministic tools may be wired through `capabilityCommands`. `coding-tooling` invokes the declared command but does not own the external tool's policy semantics; applicable convention fragments still have to match a supported deterministic adapter before they can be enforced.

## Capability catalog

The machine-readable capability catalog and family contracts describe validation tiers, artifact conventions, opt-in performance work, and baseline requirements.

General coding-agent capabilities are sourced from `coding-agent-skills`. The `agent-capabilities` command family validates that source, derives its catalog, and resolves named profiles; it does not own or reinterpret reasoning procedures.

## Design rules

1. Deterministic operations only; no LLM calls.
2. Machine-readable output is a first-class interface.
3. Checks must not silently mutate source code.
4. A missing capability is different from a failed capability.
5. Engineering policy stays in `coding-agent-conventions`; this repository may install it, deterministically project explicitly declared tool-native fragments into existing capabilities, and execute only explicitly declared deterministic enforcement, but must not invent policy.
6. Repository-specific policy stays in consumer repositories.
7. Outer agent lifecycle/orchestration stays outside this repository.
8. Prefer repository-declared commands over guessed ecosystem defaults when semantics could differ.
9. Source dependency activation may generate only explicitly managed local configuration and must never publish packages or change package versions.
10. Convention tooling adapters are a small closed set with structural merges and explicit conflicts; do not introduce arbitrary executable hooks or a universal policy DSL.

## Landscape boundaries

```text
coding-agent-skills          coding-agent-conventions
  reusable procedures          shared engineering policy
          │                      + tool-native fragments
          │                              │
          │                       installed snapshots
          │                              │
          └──────────────┬───────────────┘
                         ▼
                    coding agent
                         │
                         ▼
                    coding-tooling
        deterministic mechanics + config composition
```

- `agent-contracts` owns neutral cross-repository envelopes.
- `coding-agent-skills` owns reusable reasoning procedures and flows.
- `coding-agent-conventions` owns shared engineering policy, tool-native policy fragments, and its installable registry.
- consumer `AGENTS.md` files own repository-specific guidance and exceptions.
- `coding-tooling` owns deterministic discovery, validation, convention installation/integrity checking, supported config composition, and source-dependency mechanics.
- `runtime-profiler` owns runtime capture.
- Moonlight owns candidate evaluation.
- `agent-loop-orchestrator` owns optional durable coordination.
- `agent-loop-setup` owns machine bootstrap and the per-user component registry.

The collaboration arrows are not hard package dependencies. `coding-tooling` remains useful without the other repositories; operations report unavailable inputs rather than making unrelated commands depend on the whole landscape.