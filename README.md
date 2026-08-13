# coding-tooling

Deterministic repository operations for humans, CI, and coding agents.

`coding-tooling` is the execution layer below agent policy and orchestration. It answers four questions without requiring an LLM:

1. **inspect** — what kind of repository/components are present?
2. **check** — how do I run a named deterministic capability?
3. **affected** — what changed and which validation capabilities are relevant?
4. **doctor** — can the repository and required runtimes be used safely?

The tool deliberately does **not** decide agent policy, spawn agents, or compare baseline/candidate runs.

## Requirements

- Bun 1.3+
- Git
- Additional runtimes only when detected by a profile (`cargo`, `dotnet`)

## Local setup

```bash
bun install
bun link
coding-tooling inspect
```

## CLI

```bash
coding-tooling inspect
coding-tooling inspect --json

coding-tooling check typecheck
coding-tooling check test:unit
coding-tooling check              # all available checks, in deterministic order
coding-tooling check --json

coding-tooling affected
coding-tooling affected --base origin/main --json

coding-tooling doctor
coding-tooling doctor --json
```

All commands accept `--cwd PATH`.

## Capabilities

The stable v0.1 capability vocabulary is:

- `format`
- `lint`
- `typecheck`
- `build`
- `test:unit`
- `test:integration`
- `test:e2e`

A capability is only advertised when the detected component can actually provide it. For Bun profiles, script-backed capabilities are omitted when the corresponding `package.json` script is absent.

## Profiles

Profiles live in `profiles/` and describe deterministic commands, not policy.

| Profile | Runtime | Example commands |
| --- | --- | --- |
| `bun-typescript` | Bun | package scripts for format/lint/typecheck/build/test |
| `react-vite` | Bun | package scripts, including optional `test:e2e` |
| `rust` | Cargo | `cargo fmt`, `clippy`, `check`, `build`, `test` |
| `dotnet` | .NET | `dotnet format`, `build`, `test` |

Detection supports multiple components. A Tauri-like repository can therefore expose a React/Vite root component and a Rust `src-tauri` component at the same time.

## Machine-readable contracts

JSON output uses `schemaVersion: 1`. Initial schemas are stored in `schemas/inspection.schema.json` and `schemas/result.schema.json`.

The intended consumers are:

- local developers
- CI
- coding agents
- an agent-loop orchestrator
- differential/evidence tooling such as Moonlight

## Design boundary

- **coding-agent-conventions**: policy — what should be done and why
- **coding-tooling**: deterministic execution — how to inspect/check/diagnose
- **agent loop**: orchestration — when to call which capability
- **Moonlight**: evidence/comparison — whether candidate behavior differs from baseline

## Development

```bash
bun run format
bun run lint
bun run typecheck
bun test
```

Fixtures in `fixtures/` model the repository shapes this tool is expected to understand. Add a fixture when adding a new project/profile family.
