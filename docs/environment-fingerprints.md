# Environment fingerprints

`coding-tooling environment fingerprint --json` derives a deterministic semantic identity from repository-owned environment inputs. It is read-only and offline; it does not inspect the current machine or discover newer upstream versions.

## Layers

The v1 fingerprint contains independent digests for:

- `toolchain`: exact repository-native Bun and Rust pins plus declared Rust components;
- `native`: declared environment-v1 native package requirements;
- `dependencies`: content digests of supported root lockfiles;
- `sources`: the default registry profile or an explicit exact source-development profile;
- `config`: the semantic environment contract version/adoption state.

The combined `env-v1:sha256:...` value hashes the layer digests and selected profile. Layer inputs are emitted beside their digests so agents can explain why identity changed instead of treating the combined hash as opaque state.

## Non-inputs

Fingerprints deliberately ignore host names, users, checkout paths, timestamps, caches, README/source changes unrelated to environment identity, generated environment script bytes, compatibility-hold explanations, and source-dependency `localPath` locations.

Secret values and hashes of secret values must never enter fingerprint inputs.

## Source profiles

The default profile represents ordinary registry/distribution resolution:

```sh
coding-tooling environment fingerprint --profile default --json
```

A repository with `.coding-tooling.source-deps.json` may explicitly request a source-development identity:

```sh
coding-tooling environment fingerprint --profile source-development --json
```

The source-development fingerprint includes normalized package/Git/revision identities but not machine-specific checkout paths. Merely having a source-dependency declaration does not change the default profile.

## Verification receipts

`coding-tooling environment verify --json` computes the expected identity, observes the current environment, and emits a receipt. The machine never gets a separate filesystem-derived identity: `verifiedFingerprint` is populated only when the observed environment satisfies the expected contract.

Verification composes the existing environment-v1 conformance checks for exact Bun/Rust observations, verifies every Rust component declared in `rust-toolchain.toml` against the selected exact toolchain, checks declared apt packages through `dpkg-query` when native requirements exist, and enforces the selected source profile. The default profile rejects an active managed source override; `source-development` requires the generated source configuration to match the exact declared package/Git/revision graph and any local exact revision checks.

If a required verifier is unavailable, the receipt is `unavailable` rather than claiming equivalence without evidence. A future Nix or non-Debian backend can add a semantic native-capability verifier without changing the fingerprint contract.

A successful receipt has:

```text
expectedFingerprint == verifiedFingerprint
```

A failed or unavailable receipt keeps `verifiedFingerprint = null` and includes machine-readable diagnostics describing the mismatch.

The same receipt is embedded in `coding-tooling conformance --json`, so agents can distinguish environment mismatch from repository/test failures before interpreting the latter as regressions.
