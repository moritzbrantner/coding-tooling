# coding-tooling

Deterministic repository tooling for humans, CI, and coding agents.

This repository contains mechanical operations that should not require an LLM to rediscover or reinterpret them on every task.

## Responsibility boundary

\`coding-tooling\` answers questions such as:

- What kind of repository/components are present?
- Which validation capabilities are available?
- Which files/components changed relative to a baseline or an explicit run-owned manifest?
- How do I run a declared validation capability?
- Is the local environment able to run those capabilities?

It deliberately does **not** decide what task to implement, how an agent should reason, how worktrees or agents are managed, or whether one candidate is semantically better than another.

## v0.1 commands

\`\`\`bash
coding-tooling inspect [--root <path>] [--json]
coding-tooling check <capability> [--component <name>] [--root <path>] [--json]
coding-tooling affected [--base <git-ref> | --change-manifest <file>] [--root <path>] [--json]
coding-tooling doctor [--root <path>] [--json]
\`\`\`

Run directly during development with Bun:

\`\`\`bash
bun src/cli.ts inspect --json
\`\`\`

## Capabilities

Capabilities are stable semantic names; concrete commands are repository-specific.

\`\`\`text
format:check
lint
typecheck
build
test
test:unit
test:integration
test:e2e
gate:final
\`\`\`

\`gate:final\` maps only to a repository-declared \`check\` script. It is the complete applicable gate before handoff; \`affected\` recommendations remain early feedback and never replace it.

For JavaScript/TypeScript components, v0.1 uses declared package scripts instead of inventing commands. For Rust and .NET it exposes conservative built-in commands where the meaning is mechanically clear.

## Design rules

1. Deterministic operations only; no LLM calls.
2. Machine-readable output is a first-class interface.
3. Checks must not silently mutate source code.
4. A missing capability is different from a failed capability.
5. Repository policy stays outside this repository.
6. Outer agent lifecycle/orchestration stays outside this repository.
7. Prefer repository-declared commands over guessed ecosystem defaults when semantics could differ.
8. Never silently fall back to a different contract when an explicit baseline or change manifest is invalid.

## Relationship to the other repositories

\`coding-agent-conventions\` owns semantic conventions, \`coding-tooling\` owns deterministic operations, \`agent-loop-setup\` owns lifecycle/orchestration, and \`moonlight\` owns baseline/candidate evaluation.

\`coding-tooling\` remains usable without any of the other repositories.
