# Repository gap analysis

`coding-tooling findings --json` is the repository-local input for portfolio-wide code-gap analysis. The finding stream stays deterministic and reproducible; higher-level orchestration may aggregate or enrich findings, but it should not replace them with an LLM-only scan.

## Gap detectors

The initial structural expectations already cover TypeScript source test reachability, aggregate validation entrypoints, project configuration, CLI wiring, and explicitly required capabilities.

The gap-analysis extension adds four conservative signals:

- `package-test-capability`: production TypeScript exists but the package exposes neither `test` nor `test:unit`.
- `source-debt-marker`: production source contains TODO/FIXME comment markers. This is informational by default because deliberate debt is common and can be baselined or suppressed.
- `source-unimplemented-stub`: production source retains an explicit runtime stub such as Rust `todo!()` / `unimplemented!()`, .NET `NotImplementedException`, or an exact JavaScript/TypeScript `Error("Not implemented…")` pattern.
- `benchmark-evidence`: a package explicitly declares a `benchmark`, `benchmark:smoke`, or `bench` script but no conventional benchmark artifact can be found.

These detectors intentionally prefer false negatives over claims that cannot be established mechanically. They do not infer behavioral correctness, endpoint semantics, performance importance, or test quality.

## Portfolio use

A portfolio runner should execute this command in each repository:

```sh
coding-tooling findings --json
```

It may aggregate repository name, finding ID, expectation, severity, state, evidence, related files, verification commands, and scaffold availability. It should preserve stable finding IDs and should not automatically create one GitHub issue per finding.

Probabilistic Codex/Claude analysis belongs after aggregation as an optional enrichment stage for selected repositories or findings.
