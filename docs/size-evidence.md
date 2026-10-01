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

The collector fingerprints target, profile, features, minification, entrypoint, selection boundary, observed tool versions and the contents of declared build inputs. Run the repository's normal build immediately before collection to prove freshness. This collector cannot prove that arbitrary pre-existing files were built with the declared flags; the producing command owns that contract. Declare every build input or flag that affects comparability, including target/profile settings and packaging boundaries. Source-code changes are deliberately not comparability inputs; candidate artifacts retain their own exact hashes.

An explicitly requested `--report <path>` writes the normal result envelope using the existing report command. A reviewed, committed measurement is a versioned baseline; update it through an explicit owner-reviewed change. Compare using `--baseline <path>`. Baselines must use `coding-tooling/size-evidence/v1` and contain complete measurements with consistent identity and byte totals. Target identity or selection differences produce `comparison.state: "incomparable"` and an unavailable exit status. Missing baselines, tools, built entrypoints or empty selections are unavailable; malformed contracts are errors. Neither is a passing comparison.

Without `--baseline`, the report explicitly states `comparison.state: "not-requested"`; only the absolute byte budget is checked. With a compatible baseline, the report retains baseline bytes and signed delta bytes, checks the absolute budget, and checks the optional maximum byte increase. A passing capture without a comparison is not evidence that a regression budget passed. A repository's `size:budget` command must request its committed baseline when it promises regression checking.

The initial mechanics are opt-in. Maintained web and native consumer pilots are tracked in #160 before fleet rollout; this command alone does not establish fleet adoption.
