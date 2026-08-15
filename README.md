# coding-tooling

Deterministic repository tooling for humans, CI, and coding agents.

This repository contains mechanical operations that should not require an LLM to rediscover or reinterpret them on every task.

## Responsibility boundary

`coding-tooling` answers questions such as:

- What kind of repository/components are present?
- Which validation capabilities are available?
- Which files/components changed relative to a baseline?
- How do I run a declared validation capability?
- Is the local environment able to run those capabilities?

It deliberately does **not** decide:

- what task to implement,
- how an agent should reason through a development task,
- when to create or destroy worktrees,
- when to spawn/retry agents,
- whether one candidate is semantically better than another.

Those concerns belong to conventions/skills, outer orchestration, and evaluation tooling respectively.

## v0.1 commands

```bash
coding-tooling inspect [--json]
coding-tooling check <capability> [--component <name>] [--json]
coding-tooling affected [--base <git-ref>] [--json]
coding-tooling doctor [--json]
```

Run directly during development with Bun:

```bash
bun src/cli.ts inspect --json
```

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
test:component
storybook:build
test:storybook
test:e2e
audit:lighthouse
benchmark
benchmark:compare
gate:final
```

`gate:final` maps only to a repository-declared `check` script. It is the complete applicable gate before handoff; `affected` recommendations remain early feedback and never replace it.

For JavaScript/TypeScript components, v0.1 uses declared package scripts instead of inventing commands. For Rust and .NET it exposes conservative built-in commands where the meaning is mechanically clear.

## Capability catalog and validation tiers

The machine-readable catalog lives at [`capabilities/catalog.json`](capabilities/catalog.json). It maps repository-declared script names to semantic capabilities, progressive validation tiers, expected artifacts, opt-in cost, and baseline requirements.

```text
fast static checks
    ↓
focused behavior tests
    ↓
integration + Storybook build
    ↓
Storybook accessibility + Playwright
    ↓
Lighthouse + benchmark comparison
```

The tool reports availability and results. Repository conventions and the development loop decide which applicable tiers are required. Lighthouse and expensive benchmarks are opt-in until a reviewed baseline promotes them to a blocking gate.

Capability family contracts:

- [`capabilities/automated-tests/`](capabilities/automated-tests/)
- [`capabilities/storybook/`](capabilities/storybook/)
- [`capabilities/playwright/`](capabilities/playwright/)
- [`capabilities/lighthouse/`](capabilities/lighthouse/)
- [`capabilities/benchmarks/`](capabilities/benchmarks/)

## Design rules

1. Deterministic operations only; no LLM calls.
2. Machine-readable output is a first-class interface.
3. Checks must not silently mutate source code.
4. A missing capability is different from a failed capability.
5. Repository policy stays outside this repository. This tool reports capabilities/results; agent workflows decide when to use them.
6. Outer agent lifecycle/orchestration stays outside this repository.
7. Prefer repository-declared commands over guessed ecosystem defaults when semantics could differ.

## Relationship to the other repositories

```text
coding-agent-conventions
  conventions + development-loop skill
              │
              ▼
          coding agent
              │
              ▼
        coding-tooling
   deterministic operations

agent-loop-setup
  outer lifecycle/orchestration

moonlight
  baseline/candidate evaluation
```

`coding-tooling` must remain usable without any of the other repositories.
