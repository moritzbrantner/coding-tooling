# Deterministic generators

`coding-tooling generate` materializes code structures whose mechanical decisions have already been declared. It does not decide what an agent should build and does not contain a general-purpose code-generation or refactoring runtime.

## Generator sources

The effective catalog combines two sources:

- installed generator assets vendored under `.conventions/modules/` by `coding-agent-conventions` modules;
- repository-local generators under `.coding-tooling/generators/<id>/`.

Both use the same restricted descriptor contract. IDs are globally unique across the effective catalog; a local generator cannot silently override an installed shared generator.

```bash
coding-tooling generate list --json
coding-tooling generate describe react-component --json
coding-tooling generate plan react-component --input name=UserCard --target src/components --json
coding-tooling generate react-component --input name=UserCard --target src/components --json
```

The caller chooses an exact generator ID. `coding-tooling` does not perform natural-language intent matching or fuzzy generator selection.

## Execution contract

Generation has four deterministic phases:

```text
plan -> prerequisites -> atomic apply -> focused postconditions
```

Planning resolves typed inputs, targets, composition, templates, and the complete mutation set before any write. Target concepts must resolve to exactly one configured location or the caller must provide `--target`; tooling does not guess among repository paths.

Prerequisites are checked from local state before mutation. V1 can prove installed convention modules, repository technologies, local tools, and declared/installed packages. A missing package or a prerequisite that requires a native/dependency adapter is reported structurally and is not fetched implicitly.

Application is atomic. Existing output that exactly matches the planned result is an idempotent no-op. Existing user-owned content that would be replaced is a conflict. If a write fails after earlier writes succeeded, touched files are restored to their pre-generation state.

After successful application (including a no-op repeat), only the semantic capabilities explicitly declared as generator postconditions are run. They use the normal `coding-tooling check` capability path and stop at the first failed or unavailable postcondition.

- all postconditions pass -> `generated-and-verified`;
- apply succeeded but a postcondition fails/unavailable -> `generated-but-unverified` and the generated changes remain present;
- planning/prerequisite failure -> no mutation;
- application failure -> atomic rollback;
- collision -> no user content is overwritten.

Generated application files are one-shot scaffolds and immediately become normal repository code. Generator template changes do not synchronize or reclaim ownership of existing source.

## Local generators

A repository-local generator is self-contained:

```text
.coding-tooling/
  generators/
    feature/
      generator.json
      templates/
        feature.ts.tmpl
```

Local generators use the same discovery, planning, collision, atomicity, prerequisite, and postcondition machinery as installed convention generators. Repository-specific structure should remain local rather than being promoted into shared conventions solely to make it generatable.

## Restricted mechanics

The v1 contract intentionally supports only deterministic, inspectable mechanics:

- typed scalar inputs;
- simple interpolation plus a closed set of name transforms;
- declarative file creation;
- narrowly supported structured updates;
- explicit acyclic generator composition;
- deterministic target concepts;
- explicit prerequisites and semantic postconditions.

It deliberately does not provide arbitrary shell hooks, embedded JavaScript, loops/expressions in templates, arbitrary regex rewrites, or a universal AST/codemod DSL. Rich source transformations belong in dedicated refactoring tooling such as `local-refactor`.

## Offline and future native adapters

Generation is offline by default. V1 never discovers `latest` versions, installs missing packages, or executes ecosystem generators implicitly.

The descriptor/reporting boundary leaves room for a future **small allowlisted set** of native and package-manager adapters (for example carefully constrained `dotnet new`, `cargo new`, or exact package additions). Such adapters should require explicit network permission such as `--allow-network` when fetching is necessary, consume exact declared prerequisites, and remain a closed deterministic set. This must not become an arbitrary command/plugin execution mechanism.

## Narrow structured source mutations

Generator apply supports a deliberately closed set of existing-file mutations. `typescript-barrel-export` ensures one exact TypeScript re-export in an existing export-only barrel:

```json
{
  "kind": "typescript-barrel-export",
  "path": "src/data.ts",
  "module": "./components/data/{{name | kebab}}"
}
```

The target may contain an optional leading `"use client";`, blank lines, and `export * from "...";` declarations only. An existing export is a no-op; a missing export is inserted in lexical module order. Imports, executable statements, comments/sections, malformed exports, duplicates, or any other structure that would require interpretation fail as a generation conflict. This operation is intentionally not a generic text editor or AST/codemod surface.
