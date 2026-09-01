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

## Verification

This operation describes the **expected** environment only. A later `environment verify` operation compares observed machine evidence against the expected contract; raw machine/filesystem hashes are intentionally outside this model.
