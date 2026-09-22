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

The same receipt is embedded in `coding-tooling conformance --json`, so explicit conformance runs can distinguish environment mismatch from repository/test failures.

## Pipeline policy

Ordinary `operation: run` execution does not spend a separate semantic environment-verification step on successful validation. It performs only the setup required to execute the repository's declared commands and assumes that environment remains valid on the happy path.

Provisioning follows repository authority before verification. For an adopted environment-v1 repository, an exact Bun declaration in `package.json#packageManager` or `.bun-version` takes precedence over the composite Action's fallback Bun runtime. The Action first selects and provisions that declared version, then runs the repository setup. The fallback exists only for repositories that do not declare an environment-v1 Bun runtime. Conflicting or floating repository declarations still fail because they are ambiguous environment contracts, not because the currently installed runner version differs.

This distinction keeps verification strict as a postcondition without turning a legitimate dependency upgrade into a bootstrap failure. A Renovate change to the authoritative repository Bun pin therefore causes validation to execute on the proposed Bun version; the checks then determine whether that upgrade is compatible.

When a `run` fails and environment-v1 is declared, the composite Action performs `environment verify` as failure-only diagnostic escalation and reports whether setup also changed tracked repository state. Those diagnostics explain whether the environment plausibly caused the observed failure; they do not replace or erase the original failed command. Scheduled or manually requested environment canaries can still verify environment integrity independently without sitting on the normal PR critical path.
