# Execution-linked repository evidence

`coding-tooling` uses GitHub Pages for conservative, non-executing repository preflight. Execution-linked evidence strengthens that structural preflight by connecting repository-owned deterministic facts to explicit GitHub Actions workflow text. It does not execute workflows and it does not replace exact-head CI.

The implementation lives in `site/execution-evidence.js` and is applied by the normal `analysis.json` path.

## Evidence contract

The evidence basis is `structural`. Only explicit literal workflow values and commands can produce findings. Expressions, opaque wrappers, unsupported layouts, and shell behavior outside the bounded rules below remain unknown or unsupported rather than being guessed.

### Toolchain consistency

When the repository exposes an exact root Node, Bun, or Rust toolchain, inspected workflow declarations can be compared with it.

Supported observations include literal `node_version` / `node-version`, `bun_version` / `bun-version`, `rust_version` / `rust-version`, and literal `dtolnay/rust-toolchain@...` versions. An explicit broad or different version is contradictory evidence. A matrix expression or SHA-only action reference is not interpreted as a runtime version.

This proves only that an inspected literal declaration agrees or disagrees with the repository-owned exact pin. It does not prove which runtime a hosted runner eventually executes when the declaration is indirect.

### Lockfile consumption

For supported root lockfiles, the analyzer can classify explicit hosted dependency-resolution commands:

- `package-lock.json`: `npm ci` is deterministic consumption; ordinary `npm install`/`npm i` can resolve a new graph.
- `bun.lock` / `bun.lockb`: `bun install --frozen-lockfile` is deterministic consumption.
- `pnpm-lock.yaml`: `pnpm install --frozen-lockfile` is deterministic consumption.
- `yarn.lock`: `yarn install --immutable` or `--frozen-lockfile` is deterministic consumption.
- `Cargo.lock`: supported Cargo build/check/clippy/test/bench/package commands require `--locked` for this evidence.

Only literal `run:` commands and literal `*_command:` reusable-workflow inputs are inspected. A lockfile without an observed supported resolution command is not reported as passing or failing this property.

This evidence does not prove that every dependency source is immutable, available, or trustworthy. It proves only that the recognized execution path is or is not allowed to change the committed resolution.

### Fail-closed validation

Existing remote CI evidence already requires a relevant trigger and a recognized repository validation invocation. Execution-linked evidence additionally rejects that invocation as authoritative proof when the same mapped step explicitly suppresses failure through:

- `continue-on-error: true`; or
- an obvious trailing `|| true` / `|| :` shell suppression.

If another recognized validation path still propagates failure normally, that independent path remains valid evidence. Complex shell control flow, expressions, traps, wrappers, and indirect scripts are not interpreted.

This is not a general shell analyzer. The purpose is only to prevent mechanically obvious fail-open execution from being represented as fail-closed merge evidence.

## Relationship to convergence

These checks do not create new repository capabilities or validation jobs. They improve the oracle used by the existing convergence loop:

1. observe a repository-owned deterministic fact;
2. compare it with the actual hosted execution declaration;
3. report only a mechanically proven contradiction;
4. repair the existing execution path rather than adding another gate;
5. use exact-head CI and merged-default-branch re-analysis as authoritative acceptance.

The first motivating dogfood cases were incomplete Node runtime alignment across validation/performance/Pages surfaces, Cargo validation that did not consume a committed lockfile with `--locked`, and the requirement that explicitly suppressed validation failures must not count as authoritative green evidence.
