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
- how runtime measurements are captured or normalized,
- whether one candidate is semantically better than another.

Those concerns belong to conventions/skills, outer orchestration, evidence collectors, and evaluation tooling respectively.

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
dependencies:audit
benchmark
benchmark:smoke
```

For JavaScript/TypeScript components, v0.2 uses declared package scripts instead of inventing commands. For Rust and .NET it exposes conservative built-in commands where the meaning is mechanically clear.

External deterministic tools may also be wired through `capabilityCommands`. For example, a repository may expose a `runtime-profiler capture` invocation as its `benchmark` capability. `coding-tooling` invokes that declared command but leaves profiler bundle semantics to `runtime-profiler`; see [`capabilities/benchmarks/README.md`](capabilities/benchmarks/README.md).

## Capability catalog

The machine-readable [capability catalog](capabilities/catalog.json) and its family contracts describe broader validation tiers, artifact conventions, opt-in performance work, and baseline requirements. They remain declarative metadata; the executable capability vocabulary is the v0.2 list above.

## Design rules

1. Deterministic operations only; no LLM calls.
2. Machine-readable output is a first-class interface.
3. Checks must not silently mutate source code.
4. A missing capability is different from a failed capability.
5. Repository policy stays outside this repository. This tool reports capabilities/results; agent workflows decide when to use them.
6. Outer agent lifecycle/orchestration stays outside this repository.
7. Evidence-collector internals and evaluator semantics stay outside this repository.
8. Prefer repository-declared commands over guessed ecosystem defaults when semantics could differ.

## Relationship to the other repositories

```text
agent-contracts
  neutral interchange contracts
             │
             ├──────────────────────────────┐
             │                              │
coding-agent-conventions          agent-loop-orchestrator
  policy + development loop       scheduling + durable run state
             │                              │
             ▼                              ▼
         coding agent ───────────────► coding-tooling
                                      deterministic operations
                                               │
                          declared capability  │
                                               ▼
                                      runtime-profiler
                                      runtime evidence
                                               │
                                               ▼
                                           Moonlight
                                      evaluation/comparison
```

The arrows describe collaboration, not package dependencies:

- `agent-contracts` owns cross-repository envelopes such as evidence, check results, and evaluation results;
- `coding-tooling` owns deterministic repository discovery and execution;
- `runtime-profiler` owns runtime capture and immutable profiler bundles;
- Moonlight owns baseline/candidate evaluation;
- `agent-loop-orchestrator` decides when these components run and stores their neutral outputs;
- `coding-agent-conventions` defines policy for how agents use the results;
- `agent-loop-setup` may compose/install worker procedures but is not a source of tooling semantics.

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
validation tiers. The example includes a `dependency-update` tier that runs the universally required
build and test evidence plus repository-declared dependency audit, integration, end-to-end, and smoke
benchmark capabilities when available. Renovate and Dependabot remain proposal mechanisms; they do
not bypass this repository-owned tier.

Starter dependency-update configurations live under [`profiles/dependency-update/`](profiles/dependency-update/).
Copy the closest profile into a Consumer Repository as `.coding-tooling.json`, then add
`capabilityCommands` for repository-specific Rust Criterion, cargo-audit, .NET audit, BenchmarkDotNet,
or runtime-profiler entrypoints. Commands are argv arrays and never run through a shell.

This repository validates itself through the same composite Action in
`.github/workflows/validate.yml`, keeping local and CI behavior on one deterministic entry point.
Its committed `bun.lock` makes that self-check exercise the Action's default frozen installation
path as well.
