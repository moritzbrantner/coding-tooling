# Test execution evidence

A successful test command is not, by itself, proof that a behavioral test case executed.

`coding-tooling` therefore records native execution evidence separately from process status for recognized test capabilities. Version 1 supports Bun and Vitest as the first runner adapters.

## Evidence states

Each recognized test execution can report:

- `available` — the native runner summary provided deterministic case counts;
- `incomplete` — the runner was recognized, but coding-tooling could not recover the required case counts from its output;
- `unsupported` — the selected test command could not be conservatively resolved to a supported native runner.

The evidence keeps `passedCases`, `failedCases`, `skippedCases`, and `todoCases` separate. `executedCases` is the sum of passed and failed cases. Skipped and TODO cases are deliberately not counted as executed behavioral cases.

## Validation rule

When a supported native runner exits successfully and its evidence reports `executedCases: 0`, the coding-tooling capability fails with `failureReason: "zero-tests-executed"` and the diagnostic `test-zero-executed-cases`.

This prevents a green process that discovered no runnable tests, or only skipped/TODO tests, from becoming positive behavioral evidence.

Unsupported or incomplete runner evidence remains explicit in the result instead of being guessed into a pass or a failure. Additional runner adapters can strengthen this boundary incrementally.

## Runner resolution

For package components, coding-tooling recognizes direct Bun/Vitest commands and follows only bounded package-script wrappers of the form `bun run <script>` or `npm run <script>`. Wrapper traversal has cycle protection.

Complex shell expressions, aliases, dynamic commands, and arbitrary script execution are not interpreted as runner identity. This is an evidence boundary, not a shell parser.

## Static test-state findings

Execution evidence is complemented by two source findings:

- `test-focused-case` reports direct committed `test.only`, `it.only`, or `describe.only` calls;
- `test-disabled-case` reports direct committed `test.skip`, `it.skip`, `describe.skip`, `test.todo`, or `it.todo` calls.

These findings are intentionally conservative and line-oriented. They do not infer aliases or computed test APIs.

## What this does not prove

Native execution counts do not prove that assertions are meaningful, that every public behavior is covered, or that every reachable function and branch executed. Those are separate evidence layers: public-contract-to-case mapping, measured function/branch coverage, and test-strength analysis.
