# Remote testing scaffold plans

`coding-tooling` exposes a browser-executed testing plan for public GitHub repositories at:

```text
https://moritzbrantner.github.io/coding-tooling/testing.json/?repo=owner/repository
```

The purpose is narrower than a coding agent: give GitHub-capable ChatGPT or another lightweight orchestrator enough deterministic structural information to assemble a focused testing-scaffold pull request without cloning the repository or starting Codex inside a development environment.

## Contract

Schema version 1 returns `operation: "remote-testing-scaffold-plan"` with repository provenance, discovered package components, ordered actions, a suggested pull-request title, application instructions, and explicit limitations.

The plan currently covers TypeScript/React packages discovered by the existing Pages preflight:

- a package with TypeScript source but no canonical `test:unit` capability receives a `test-runner-setup` action;
- TypeScript production source without a structurally matching test/spec file receives a `unit-test` target;
- a React package with component-shaped TSX files but no Storybook dependency receives a `storybook-setup` action;
- component-shaped TSX files without a structurally matching story receive a `storybook-story` target.

Test paths follow the local detector convention of mapping `src/foo.ts` to `tests/foo.test.ts` (and preserving TSX where needed). Story paths are adjacent to the component as `Component.stories.tsx`.

## Deliberate boundary

The remote plan does **not** generate behavioral assertions from filenames. For every file-level action, the consumer must read `sourcePath` before writing `targetPath`. Type-only modules, barrels, generated adapters, and other files without useful runtime behavior may be skipped with an explicit reason rather than receiving meaningless tests.

React component detection is deliberately conservative: schema version 1 treats TSX files under conventional `components`/`ui` paths, or TSX files with PascalCase filenames, as Storybook candidates. That is structural evidence, not proof that the file is a reusable component, so these actions carry medium confidence until the source is inspected.

The local `coding-tooling findings --json` path remains authoritative because it can inspect source reachability and run repository-owned validation. The Pages plan is a zero-install PR-planning seam, not a replacement for CI.

## Intended lightweight workflow

A GitHub-capable assistant can:

1. open `testing.json/?repo=owner/repository` in a browser-capable context;
2. apply setup actions before actions that depend on them;
3. fetch each listed `sourcePath` directly from GitHub;
4. create the smallest deterministic test/story at the listed `targetPath`, following `applyPolicy`;
5. open one focused pull request and let repository CI validate the result.

This keeps the expensive coding-environment agent reserved for cases where the deterministic plan is insufficient or CI exposes a real integration problem.
