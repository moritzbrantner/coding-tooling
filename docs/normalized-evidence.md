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

A root Bun lock, root `packageManager`, or root `.node-version` is not silently copied into an unrelated nested package. Nested `.node-version` files are collected when available, and package command selection uses the component's own manifest/lock evidence. Workspace inheritance is intentionally not guessed in this slice: a future adapter may establish an inherited toolchain only when the workspace relationship itself is mechanically evidenced.

Structural test reachability, Rust/.NET normalized evidence, CI validation evidence, and governance evidence remain incremental work under #84/#86/#85 rather than reasons to duplicate or broaden the evidence model speculatively.
