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

## Commands

```bash
coding-tooling inspect [--json]
coding-tooling check <capability> [--component <name>] [--json]
coding-tooling affected [--base <git-ref>] [--json]
coding-tooling doctor [--json]
coding-tooling plan --tier fast [--json]
coding-tooling run --tier fast --report .artifacts/coding-tooling/report.json --strict --json
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
test:e2e
```

For JavaScript/TypeScript components, v0.2 uses declared package scripts instead of inventing commands. For Rust and .NET it exposes conservative built-in commands where the meaning is mechanically clear.

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

## Private GitHub Action

The repository root is a composite GitHub Action for private repositories owned by the same GitHub
account. Give those repositories access under **Settings → Actions → General → Access**, then pin
an immutable tag or commit:

```yaml
- uses: moritzbrantner/coding-tooling@coding-tooling-v0.2.0
  with:
    tier: fast
    strict: true
```

The Action executes the same CLI used locally and writes
`.artifacts/coding-tooling/report.json`. It deliberately does not check out the consumer repository;
the caller owns checkout, permissions, and the surrounding job. By default it installs consumer
dependencies from `bun.lock`, `bun.lockb`, or `package-lock.json`; callers that already installed
dependencies can set `install-mode: none`.

Public repositories cannot consume this private Action. They should continue to use public actions
and repository-local commands.

Copy `.coding-tooling.example.json` to `.coding-tooling.json` when a consumer needs custom
validation tiers.

This repository validates itself through the same composite Action in
`.github/workflows/validate.yml`, keeping local and CI behavior on one deterministic entry point.
