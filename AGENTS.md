# Repository agent guidance

This file contains repository-specific guidance for coding agents working in `coding-tooling`. Shared conventions live under `.conventions/`; do not duplicate them here.

## Tooling

- Use Bun 1.4.0, as pinned by `package.json`.
- Prefer repository-declared scripts and capabilities over invented commands.
- Run cheap deterministic checks before broader validation: `bun run format:check`, `bun run lint`, `bun run typecheck`, then `bun run test`.
- Before finalizing a change, run `bun run check` and `bun run findings`.

## Repository boundaries

- Treat `fixtures/` as test data, not production components or repository toolchains.
- Keep the GitHub Pages preflight conservative and structural; it must not imply behavioral correctness, security, coverage, or runtime-performance guarantees.
- Keep local CLI analysis authoritative for conformance, findings, environment verification, validation execution, and mutations.

## Authority boundaries

- Owns: `coding-tooling/deterministic-evidence`, `coding-tooling/validation-selection`, `coding-tooling/pr-integration-mechanics`, `coding-tooling/fleet-metadata`
- Adapts: `coding-agent-conventions/policy`, `coding-agent-skills/procedures`
- Non-authoritative: `product-domain-semantics`, `human-architecture-decisions`
- Prohibited write-back: remote or browser analysis must not mutate repository state except through an explicit authoritative local command

## Change discipline

- Add or update tests for behavioral changes.
- Do not weaken deterministic checks merely to silence findings; fix the source or make the analysis boundary explicit.
- Preserve machine-readable schemas and CLI output contracts unless a change explicitly versions or documents them.
