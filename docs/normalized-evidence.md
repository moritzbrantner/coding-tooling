# Normalized evidence

`coding-tooling` has local filesystem analysis and a bounded GitHub Pages preflight. Acquisition differs between those environments, but mechanically equivalent facts should not acquire different meanings merely because one collector reads a checkout and the other reads GitHub metadata.

The normalized evidence seam keeps those responsibilities separate:

1. **Collectors acquire facts.** A collector records where a fact came from and whether it was available. It does not turn missing evidence into a successful check.
2. **Normalized evidence is versioned data.** Package evidence currently uses `schemaVersion: 1` and retains collector/path provenance for manifest, script, dependency, package-manager, Node-version, TypeScript-config, and component-owned lockfile facts.
3. **Pure semantics consume evidence.** Technology classification, canonical script discovery, package-toolchain classification, and canonical package-capability outcomes operate only on normalized data. They perform no filesystem, browser, GitHub, process, or network calls.
4. **Presentation remains source-specific.** The local CLI and Pages preflight may expose different amounts of evidence, but shared outcomes must have the same meaning for equivalent facts.

## Package evidence

`site/evidence-model.js` is intentionally browser- and filesystem-neutral even though it lives under `site/`; placing the pure module there lets the static Pages artifact consume the same implementation without a second build or copied semantic implementation. `site/evidence-model.d.ts` gives the local TypeScript collector the same contract.

The local collector reuses `discoverComponents` for component identity and adds manifest/context facts. The remote collector uses the GitHub tree/blob snapshot. Both feed the same pure package semantics.

Canonical capability outcomes are explicit:

- `satisfied` — the declared scripts mechanically provide the capability;
- `finding` — script evidence is available and the capability is absent;
- `incomplete` — the required evidence was not available and must not be treated as satisfied.

Package toolchain outcomes add the fourth state required for environment boundaries:

- `satisfied` — the component has an exact supported Bun or Node version fact;
- `finding` — supported version evidence exists but is not exact;
- `unsupported` — the component explicitly declares a package manager the current remote adapter does not model;
- `incomplete` — no component-local supported version fact is available.

A root Bun lock, root `packageManager`, or root `.node-version` is not silently copied into an unrelated nested package. Nested `.node-version` files are collected when available, and package command selection uses the component's own manifest/lock evidence. The workspace adapter establishes inheritance only for supported, explicit root workspace membership patterns; exclusions and unsupported patterns do not imply membership. Conflicting member identities remain findings.

The shared structural, CI-validation and governance evidence modules follow the same acquisition/pure-semantics boundary. Rust/.NET manifest facts retain all same-directory manifests and their provenance.

## Rust and .NET declaration evidence

`site/project-toolchain.js` and its declaration contract define schema version 1
native toolchain facts. Independent filesystem and GitHub collectors populate
repository-contained declaration paths and text, completeness and provenance.
Remote components expose `projectEvidence`, `toolchainEvidence` and `toolchain`.
Pure semantics never acquire files or execute native tools.

The lookup follows known ancestor-directory relationships from each component's
working directory, preferring the closest declaration and retaining its owner
in `inheritedFrom`. It does not use sibling files or declarations outside the
repository. This models [rustup's file lookup and legacy precedence](https://rust-lang.github.io/rustup/overrides.html)
and [.NET's SDK declaration lookup](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
The .NET CLI starts from the invocation directory; MSBuild solution/project
resolution may have a different starting point. Custom invocation directories,
ambient overrides and active installed toolchains require local verification.

- `satisfied`: an exact stable version declaration is supported; .NET additionally declares `rollForward: disable`.
- `finding`: a complete inventory proves absence, a supported version is not exact, or .NET permits roll-forward (including its default patch policy).
- `unsupported`: custom Rust toolchains, unmodeled TOML constructs or unmodeled SDK declarations cannot establish an exact pin.
- `incomplete`: a truncated tree could hide a closer declaration, or the selected declaration was not acquired/readable. A readable root file cannot hide this gap.

Rust parsing is bounded to the ordinary `[toolchain]` table with literal strings
and literal string arrays, plus the legacy one-line file. Escaped or multiline
strings, inline/dotted tables, unknown keys and ambiguous declarations stay
unsupported. This does not validate an entire native toolchain file or prove a
compiler installation, command success, target support or runtime compatibility.
Local collection treats symlinks and non-files as unavailable rather than
following them across the analysis boundary.

Existing root Rust missing/non-exact finding IDs remain stable; nested findings
add deterministic component suffixes. Other native declaration gaps use
`REMOTE-ENV-009`. These are advisory remote findings. Canonical package
capability facts still describe declared scripts, independently of execution.

## Structural test evidence

Remote structural source/test evidence now uses the same pure outcome semantics in ordinary preflight and change-aware analysis. Ownership is component-scoped to the most-specific compatible package, Rust, or .NET component.

The outcome is explicitly one of `satisfied`, `finding`, `unsupported`, or `incomplete`. It reports structural paths and supported acquired source markers only and never claims assertion intent or execution success. Rust without a separate test path remains unknown until bounded source acquisition can establish inline test markers; unavailable or incomplete Rust source remains explicit. Incomplete GitHub tree/manifest evidence remains `incomplete`, never satisfied.

`tests/remote-component-calibration.test.js` uses the existing calibration scorer
with explicit positive, negative and unknown component labels. It keeps sibling
test evidence independent, preserves unavailable Rust source as unknown, excludes
fixture components, and checks deliberate precision/recall mutations. The normal
repository gate runs this labeled remote case alongside the local corpus.
