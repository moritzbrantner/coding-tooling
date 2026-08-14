# coding-tooling

Deterministic repository tooling for humans, CI, and coding agents.

This repository contains mechanical operations that should not require an LLM to rediscover or reinterpret them on every task.

## Responsibility boundary

`coding-tooling` discovers repository components and validation capabilities, maps changed files to
components, executes declared checks, and diagnoses whether the environment can run them. It does
not choose tasks, reason about implementations, manage worktrees or agents, or decide whether one
candidate is semantically better than another.

## Commands

```bash
coding-tooling inspect --json
coding-tooling check lint --json
coding-tooling affected --base main --json
coding-tooling doctor --json
coding-tooling plan --tier fast --json
coding-tooling run --tier fast --report .artifacts/coding-tooling/report.json --strict --json
```

Run directly during development with Bun:

```bash
bun src/cli.ts inspect --json
```

Stable capabilities are `format:check`, `lint`, `typecheck`, `build`, `test`, `test:unit`,
`test:integration`, and `test:e2e`. JavaScript and TypeScript components use declared package
scripts. Rust and .NET components use conservative built-in commands where semantics are clear.

## Private GitHub Action

The repository root is also a composite GitHub Action for private repositories owned by the same
GitHub account. Give consumer repositories access under **Settings → Actions → General → Access**,
then pin an immutable tag or commit:

```yaml
- uses: moritzbrantner/coding-tooling@coding-tooling-v0.2.0
  with:
    tier: fast
    strict: true
```

The Action executes the same CLI used locally and writes
`.artifacts/coding-tooling/report.json`. It deliberately does not check out the consumer repository;
the caller owns checkout, permissions, and the surrounding job.

Public repositories cannot consume this private Action. They should continue to use public actions
and repository-local commands.

Copy `.coding-tooling.example.json` to `.coding-tooling.json` when a consumer needs to customize its
`fast`, `integration`, `e2e`, or `full` tiers.

## Design rules

1. Deterministic operations only; no LLM calls.
2. Machine-readable output is a first-class interface.
3. Checks must not silently mutate source code.
4. A missing capability is different from a failed capability.
5. Repository policy and agent lifecycle stay outside this repository.
6. Prefer repository-declared commands over guessed ecosystem defaults.

## Landscape

- `coding-agent-conventions` defines what and why.
- `coding-tooling` provides deterministic execution.
- `reusable-workflows` adapts that execution to GitHub Actions.
- `agent-loop-orchestrator` owns local run lifecycle.
- `moonlight` evaluates baselines and candidates.

`coding-tooling` remains usable without any of the other repositories.
