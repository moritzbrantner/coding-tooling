# Change-aware GitHub Pages analysis

The GitHub Pages surface can derive an affected-component view and a non-executing validation plan from either a GitHub base/head comparison or an explicit set of changed paths.

The purpose is to let a coding agent answer, before cloning:

- which discovered components own the change;
- whether the change has cross-component impact and must widen validation;
- which repository contracts govern the affected components;
- which structurally related tests are worth reading first;
- what advisory component-level structural test evidence exists;
- which repository-declared validation commands form the smallest safe component-scoped plan for the selected tier; and
- which merge authority and hosted check names the repository declares without claiming those checks have run.

Pages still does not execute repository code. Local `coding-tooling` or hosted repository CI remains authoritative for validation results.

## CLI-style `run.json`

`run.json` recognizes the existing `affected` vocabulary when the operation can be derived from public GitHub data:

```text
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=affected%20--base%20main%20--head%20feature%20--json
```

A validation plan can consume the same change context:

```text
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=plan%20--tier%20fast%20--base%20main%20--head%20feature%20--json
```

Callers that already know the changed paths can avoid GitHub compare by repeating `--changed-file`:

```text
coding-tooling affected --changed-file src/a.ts --changed-file tests/a.test.ts --json
```

On Pages this argv is passed through `run.json`; it is not executed as a local CLI process.

## Dedicated `affected.json` view

The browser-only machine view is also available directly:

```text
https://moritzbrantner.github.io/coding-tooling/affected.json/?repo=owner/repository&base=main&head=feature&tier=fast
```

Explicit paths use repeated `file` query parameters:

```text
https://moritzbrantner.github.io/coding-tooling/affected.json/?repo=owner/repository&file=src/a.ts&file=tests/a.test.ts
```

As with the other Pages JSON views, this is a browser-executed static page rather than a server-side `application/json` API.

## Scope rules

Component ownership is derived mechanically from the most specific discovered component path. A nested package or crate therefore owns its own source changes instead of also marking a repository-root component as affected.

Some paths are intentionally cross-component:

- `.coding-tooling.json`, installed convention snapshots, and GitHub Actions workflows widen to every discovered component;
- root package-manager, TypeScript, lint, and formatting contracts affect package components;
- root Cargo/toolchain contracts affect Rust components; and
- root .NET solution/build contracts affect .NET components.

If GitHub truncates the tree or compare evidence, selected manifests cannot be read, or a non-documentation path cannot be mapped safely, the result widens conservatively and returns `status: "unavailable"`. Missing evidence is never interpreted as proof that a component is unaffected.

Documentation-only changes select no code validation commands. This optimization is limited to documentation file extensions; executable files under `docs/` are not automatically classified as documentation-only.

## Candidate tests and governing contracts

For every affected component the result includes:

- `changedPaths` — the paths attributed to that component;
- `governingContracts` — structural contracts such as `.coding-tooling.json`, the component manifest, the nearest `AGENTS.md`, directly changed contract/invariant/schema files, and changed `agent-tool.json` machine descriptors;
- `testEvidence` — advisory tree-only component evidence with explicit `satisfied | finding | unsupported | incomplete` state, changed test paths, and test-path counts;
- `candidateTests` — a bounded, deterministic shortlist of test-like files, ranked toward directly changed tests and files whose stems match changed source files; fixture, vendor, dependency, coverage, and build-output test trees are excluded from fallback navigation; and
- `selectedCapabilities` — the selected tier capabilities that the component can actually provide.

`candidateTests` and `testEvidence` are navigation/structural evidence, not claims of behavioral coverage. A coding agent still has to read source and tests before deciding what proves the intended behavior. Rust with no separate test path remains `unsupported` rather than a missing-test claim because inline `#[cfg(test)]` modules are not tree-visible.

## Declared merge authority

When `.coding-tooling.json` declares `merge.authority`, the change-aware result includes `declaredMergeAuthority`. Hosted authority exposes the sorted declared `requiredChecks`; local authority exposes its reason. `observedEnforcement` is always `not-evaluated` on this Pages surface: the declaration is agent guidance, not proof of branch protection or current check conclusions. Invalid hosted/local declarations fail closed instead of being serialized as usable acceptance evidence.

## Why capability pruning stays conservative

The remote planner narrows by component but does not infer that a repository-declared tier capability is unnecessary merely from a file extension. If a component is affected, every available capability selected by the requested tier remains in the plan.

Further capability-level pruning should require an explicit repository-owned change-routing contract. That keeps the optimization deterministic and prevents Pages from silently weakening acceptance policy.
