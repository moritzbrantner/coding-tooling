# Rust structural test reachability

`rust-source-test` extends repository findings to Rust without claiming behavioral coverage.

## Proven source surface

The detector reuses `coding-tooling` Rust component discovery. Within each component it starts from mechanically established crate roots (`src/lib.rs`, `src/main.rs`, auto-discovered `src/bin/*.rs`, and recognized explicit lib/bin targets) and follows only resolvable file-module declarations such as `mod service;`.

Conditional module declarations are not followed. Source that cannot be related to a crate root through this conservative graph is not guessed into the finding surface. Rust therefore remains listed in `unsupportedTechnologies` even when `rust-source-test` is applied.

## Test evidence

A reachable Rust source becomes structurally test-reachable when one of these deterministic seeds reaches it through the same module graph:

- the source contains an inline `#[cfg(test)] mod ... {}` unit-test module;
- a Cargo integration-test root under `tests/*.rs` references the package crate identifier;
- a reachable integration-test support module references the package crate identifier;
- an integration test references a binary through Cargo's `CARGO_BIN_EXE_<name>` environment signal.

Integration-test support modules are followed only through mechanically resolvable `mod foo;` or explicit `#[path = "..."] mod foo;` declarations. Conditional test-module relationships are not guessed.

## Findings

A source surface without recognized evidence receives a stable `rust-source-test` warning. Its verification command is `cargo test` for a root crate or `cargo test --manifest-path <Cargo.toml>` for a nested crate.

The finding has no scaffold. `coding-tooling` does not create empty, ignored, or TODO Rust tests merely to silence structural debt.

## Deliberate limitations

This detector does not infer:

- function-level or route-level behavioral coverage;
- re-export relationships;
- conditional module graphs;
- macro-expanded module structure;
- arbitrary Cargo target semantics;
- whether an assertion is meaningful;
- code-coverage percentages.

Those limitations remain visible through findings coverage metadata rather than being replaced by heuristics.
