# Test execution evidence

A successful test command is not, by itself, proof that a behavioral test case executed.

`coding-tooling` therefore records native execution evidence separately from process status for recognized test capabilities. Version 1 supports Bun and Vitest as the first runner adapters.

## Evidence states

Each recognized test execution can report:

- `available` — the native runner summary provided deterministic case counts;
- `incomplete` — the runner was recognized, but coding-tooling could not recover the required case counts from its output;
- `unsupported` — the selected test command could not be conservatively resolved to a supported native runner.

The evidence keeps `passedCases`, `failedCases`, `skippedCases`, and `todoCases` separate. `executedCases` is the sum of passed and failed cases. Skipped and TODO cases are deliberately not counted as executed behavioral cases. Where the native summary exposes it, `executedFiles` records the number of files participating in the run separately from case counts.

## Native discovery evidence

A recognized package test capability also records test-file discovery independently from execution:

- Bun uses the resolved native `bun test` command, the package's `bunfig.toml` test root and path-ignore configuration, documented conventional file patterns, and a read-only `--dry-run` probe. Positional file filters and CLI path-ignore overrides are preserved. Unsupported command/config shapes remain `incomplete` instead of being guessed.
- Vitest derives a read-only `vitest list --filesOnly` invocation from the resolved native command and treats the returned file list as authoritative runner discovery.

Candidate and discovered files are component-scoped. Tests below a nested repository component are not attributed to the parent package. If native Vitest discovery crosses such a boundary, the evidence is incomplete rather than silently reassigning ownership.

For bounded diagnostics, file lists are capped while the full counts remain available. A conventional candidate omitted by native discovery is reported through `test-files-excluded-by-runner`; this exposes deliberate exclusions for review without automatically claiming they are defects.

GitHub Pages remains structural-only: its existing component-owned test-path evidence can show which committed test files belong to a component, but it does not claim native discovery or execution. Local/CI runner evidence is authoritative for the discovery/execution relationship.

## Validation rules

When a supported native runner exits successfully and its evidence reports `executedCases: 0`, the coding-tooling capability fails with `failureReason: "zero-tests-executed"` and the diagnostic `test-zero-executed-cases`.

This prevents a green process that discovered no runnable tests, or only skipped/TODO tests, from becoming positive behavioral evidence.

When both native discovery and execution expose complete file counts, coding-tooling reconciles them. A successful process whose native discovery count differs from its execution-reported file count fails with `failureReason: "test-discovery-execution-mismatch"`. Unsupported or incomplete discovery/execution evidence remains explicit and is never converted into a passing reconciliation claim.

## Runner resolution

For package components, coding-tooling recognizes direct Bun/Vitest commands and follows only bounded package-script wrappers of the form `bun run <script>` or `npm run <script>`. Wrapper traversal has cycle protection.

Complex shell expressions, aliases, dynamic commands, and arbitrary script execution are not interpreted as runner identity. This is an evidence boundary, not a shell parser.

## Static test-state findings

Execution evidence is complemented by two source findings:

- `test-focused-case` reports direct committed `test.only`, `it.only`, or `describe.only` calls;
- `test-disabled-case` reports direct committed `test.skip`, `it.skip`, `describe.skip`, `test.todo`, or `it.todo` calls.

These findings are intentionally conservative and line-oriented. They do not infer aliases or computed test APIs.

## What this does not prove

Native discovery and execution counts do not prove that assertions are meaningful, that every public behavior is covered, or that every reachable function and branch executed. Those are separate evidence layers: public-contract-to-case mapping, measured function/branch coverage, and test-strength analysis.
