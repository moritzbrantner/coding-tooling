# Normalized evidence

`coding-tooling` has local filesystem analysis and a bounded GitHub Pages preflight. Acquisition differs between those environments, but mechanically equivalent facts should not acquire different meanings merely because one collector reads a checkout and the other reads GitHub metadata.

The normalized evidence seam keeps those responsibilities separate:

1. **Collectors acquire facts.** A collector records where a fact came from and whether it was available. It does not turn missing evidence into a successful check.
2. **Normalized evidence is versioned data.** Package evidence currently uses `schemaVersion: 1` and retains collector/path provenance for manifest, script, dependency, package-manager, TypeScript-config, and component-owned lockfile facts.
3. **Pure semantics consume evidence.** Technology classification, canonical script discovery, and canonical package-capability outcomes operate only on normalized data. They perform no filesystem, browser, GitHub, process, or network calls.
4. **Presentation remains source-specific.** The local CLI and Pages preflight may expose different amounts of evidence, but shared outcomes must have the same meaning for equivalent facts.

## Initial package slice

The first slice of issue #83 covers package evidence only. `site/evidence-model.js` is intentionally browser- and filesystem-neutral even though it lives under `site/`; placing the pure module there lets the static Pages artifact consume the same implementation without a second build or copied semantic implementation. `site/evidence-model.d.ts` gives the local TypeScript collector the same contract.

The local collector reuses `discoverComponents` for component identity and adds manifest/context facts. The remote collector uses the GitHub tree/blob snapshot. Both feed the same pure package semantics.

Canonical capability outcomes are explicit:

- `satisfied` — the declared scripts mechanically provide the capability;
- `finding` — script evidence is available and the capability is absent;
- `incomplete` — the required evidence was not available and must not be treated as satisfied.

This slice does **not** yet migrate package-manager inheritance, structural test reachability, Rust/.NET evidence, CI validation evidence, or governance evidence. Those remain incremental work under #83/#84/#86/#85 rather than reasons to duplicate the evidence model now.
