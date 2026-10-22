# Deterministic normalization

`coding-tooling normalize` applies only closed, repository-derived mutation adapters whose purpose is canonicalization rather than implementation. It runs those mutations in deterministic order and immediately repeats the complete pass. The second pass must leave repository content unchanged.

```bash
coding-tooling normalize --json
```

## Selecting files

By default every adapter runs over its whole component. A selection restricts the run to chosen files:

```bash
coding-tooling normalize src/a.ts src/b.rs   # explicit paths (relative to the current directory)
coding-tooling normalize --staged            # files in the git index; re-staged afterwards
coding-tooling normalize --changed           # working-tree changes against HEAD plus untracked files
coding-tooling normalize --changed --base origin/main
```

Each adapter receives only the selected files inside its component that its tool understands (Oxfmt: JS/TS/JSON/Markdown/CSS/YAML/TOML/…; Oxlint: JS/TS and framework files; Rust: `.rs`; .NET: `.cs`/`.vb`/`.fs`). Adapters with no matching file do not run.

- Oxfmt/Oxlint run the package-local binary with the committed script's flags (and any composed convention config) and the selected files in place of its path targets.
- Rust runs `rustfmt --edition <manifest edition>` on the files, because `cargo fmt` cannot target files. rustfmt still follows out-of-line `mod` declarations of a selected file.
- .NET appends `--include <files>` to the `dotnet format` command.

`--staged` excludes files that also have unstaged edits (reported as `partiallyStaged`) so normalization never stages unrelated work; after a successful run it `git add`s exactly the normalized files (`restaged`), which makes it suitable for a pre-commit hook. An adapter that cannot be scoped (for example a missing package binary) is reported in `unscopable` instead of falling back to a whole-repository run. The fixed-point proof below still applies to selected runs.

Normalization is a mutation phase, not a validation phase and not an agent. It does not decide business behavior, remove TODO work markers, invent lint fixes, run arbitrary package scripts, or weaken checks.

## Current adapters

The first adapter set is deliberately small:

- package Oxfmt formatting through a safe `format:write`, `format:fix`, or equivalent write-mode Oxfmt script;
- package Oxlint fixes through an explicit safe `lint:fix`/`lint:write` script using ordinary `--fix` only;
- direct Oxfmt check commands by removing `--check`;
- Rust `cargo fmt --check` -> `cargo fmt`;
- .NET `dotnet format ... --verify-no-changes` -> `dotnet format ...`;
- direct Oxlint commands by adding ordinary `--fix` when no stronger fix mode is requested.

Package mutation scripts are accepted only when their committed script body is a single recognized Oxfmt or Oxlint command without shell composition. Unknown formatter/linter ecosystems and unsafe or ambiguous scripts are reported as unsupported. They remain owned by the later validation phase.

## Fixed-point proof

Normalization computes a repository-content fingerprint before mutation, after the first pass, and after the second pass.

```text
state 0
  -> lint-safe-fix
  -> format-write
  -> state 1
  -> lint-safe-fix
  -> format-write
  -> state 2

accept only when state 1 == state 2
```

If any mutation command fails, or if the second pass changes repository content again, normalization fails closed. File modification times are irrelevant; the fingerprint is based on repository-relative paths and file content. Symlinks are fingerprinted as links rather than followed.

## Role in convergence

`coding-tooling converge` invokes normalization whenever deterministic scaffolding reaches a structural fixed point, then re-runs findings. This matters because canonicalization can expose or remove mechanically visible structure. If new deterministic scaffold work appears, convergence re-enters the scaffold phase within its existing round bound.

The intended development loop is therefore:

```text
generator/scaffold
  -> explicit implementation markers
  -> agent implements semantics
  -> deterministic normalization
  -> findings re-analysis
  -> deterministic validation
  -> fixed point or explicit residual handoff
```

Normalization does not make generated files tool-owned. Application source remains normal repository code after generation and after every normalization pass.
