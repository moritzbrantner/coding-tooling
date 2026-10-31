# Built artifact size evidence

`coding-tooling performance size --root <repository> --json` reads explicitly selected built files. It does not build, install, run a profiler, refresh a baseline or change a budget. The metric is raw on-disk artifact bytes, separate from compressed transfer size, linker symbols, runtime latency and memory. Optional ecosystem analyzers remain separate enrichment.

Bun consumer scripts may import `sizeEvidence` from the narrow package export `coding-tooling/size-evidence` instead of loading the complete CLI. Source-development consumers use an exact Git revision through their normal package manager; no publication is required.

Repositories expose `size:budget` through a package script or explicit `capabilityCommands` mapping. Discovery never substitutes a build command or guesses a size threshold. Performance-tier bootstrap includes a declared size capability.

Commit `.performance/size.json` with this versioned contract:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "id": "public-js",
      "kind": "web",
      "entrypoint": "dist/index.js",
      "artifacts": [{ "path": "dist", "extensions": [".js"] }],
      "target": "browser",
      "profile": "production",
      "features": [],
      "minification": "minified",
      "toolchains": [["bun", "--version"]],
      "buildInputs": ["scripts/build.ts", "bun.lock"],
      "maxBytes": 901120,
      "maxIncreaseBytes": 4096
    }
  ]
}
```

For a native target use `kind: "native"`, the actual binary path as entrypoint and artifact selector, an explicit target triple, profile and features, `minification: "not-applicable"`, and Cargo/rustc version probes plus the relevant Cargo manifests, lockfile and build configuration. Repository owners declare these values and build flags; the collector records them, not infer them from the binary.

Each selector names a regular file or a directory with explicit extensions. Directory traversal is bounded, sorted, rejects symlinks including ancestors, and deduplicates overlapping selections. The entrypoint must be selected. Each artifact records its path, exact byte count and SHA-256. Toolchain argument vectors execute without a shell, with a ten-second timeout and bounded captured output. Only trusted repository declarations should be executed.

Each target's `identity` hashes its declared build shape: id, kind, entrypoint, selection boundary, target, profile, features and minification. Observed tool versions and the SHA-256 of each declared build input are recorded alongside but are not part of the identity. Run the repository's normal build immediately before collection to prove freshness. This collector cannot prove that arbitrary pre-existing files were built with the declared flags; the producing command owns that contract.

### Adopting an existing ad-hoc measurement

A script that already builds and prints sizes, such as physics-engine's `scripts/oracle-wasm.mjs`, adopts this collector without changing what it builds:

1. Have the script copy each variant to its own stable path after building it, for example `target/size/engine.wasm` and `target/size/rapier.wasm`. Variants that overwrite one output path cannot be selected separately.
2. Declare one `native` target per variant. Each target sets the WASM triple (`wasm32-unknown-unknown`), `profile: "release"`, that variant's `features`, `minification: "not-applicable"`, a `cargo --version` toolchain probe, and the manifest, lockfile and script as `buildInputs`.
3. Expose `size:budget` as `<the script> && coding-tooling performance size`, and drop the script's own size printout. For `maxIncreaseBytes`, add the base-branch comparison below.

### Comparing against the base branch

There is no committed baseline. The baseline for `maxIncreaseBytes` is the base branch measured in the same CI run, with the same toolchain:

1. Check out the PR's base commit into a subdirectory, run the same build there and write its measurement with `coding-tooling performance size --root <base checkout> --report base-size.json`.
2. Run the build in the PR checkout and judge it with `coding-tooling performance size --baseline base-size.json`.

On push to the default branch there is no base, so skip step 1 and omit `--baseline`; only `maxBytes` applies.

A baseline must be a completed `coding-tooling/size-evidence/v2` report with consistent identity and byte totals; an old or malformed one is an error and a missing requested file is unavailable. Missing tools, built entrypoints or empty selections are unavailable. Each target's `comparison.state` is one of:

- `not-requested`: no `--baseline`; only `maxBytes` is checked.
- `comparable`: same build shape. The report holds `baselineBytes`, signed `deltaBytes` and `drift`, the tool versions and build inputs that differ from the base (for example a Rust release or a `Cargo.lock` bump in the PR). Drift is context, not a reason to skip the comparison; `maxIncreaseBytes` is checked.
- `new`: the base measurement has no target with this id.
- `incomparable`: the PR changes the declared build shape (target, profile, features, minification or selection), so bytes are not compared. The shape change is visible in the declaration diff.

Only `maxBytes` and `maxIncreaseBytes` failures make the status `failed`; `new` and `incomparable` targets pass on their absolute budget.

Without `--json` the command prints one row per target (target, bytes, max, baseline, delta with its allowed increase, state), followed by failures, incomparable reasons and drift. `--json` prints the result envelope; `--report <path>` writes it to a file.

The initial mechanics are opt-in. Maintained web and native consumer pilots are tracked in #160 before fleet rollout; this command alone does not establish fleet adoption.
