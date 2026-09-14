# Source development mode

Source development mode keeps package publication out of the ordinary implementation loop.

A consumer repository commits `.coding-tooling.source-deps.json` with the exact source revisions that temporarily replace registry packages. `coding-tooling source-deps activate` materializes a managed `.cargo/config.toml` containing Cargo `[patch.crates-io]` entries. `status` reports whether that managed configuration is active and `deactivate` removes it.

## Source contracts

Schema version 1 is the original local-or-Git format. Each Cargo patch declares its package, source repository URL, exact Git revision, and optional sibling package path.

Schema version 2 adds `cargo.localOnly: true`. Every patch must then declare `localPath`, the sibling checkout must exist, and its `HEAD` must match the pinned revision. Missing local source is an error: coding-tooling never falls back to an authenticated Git fetch in local-only mode. The source repository URL remains provenance rather than a hidden network fallback.

Schema version 3 keeps the same local-only behavior but moves the exact revision to the repository boundary. One repository entry declares `git`, `rev`, an optional repository-level `localPath`, and the package names plus package-relative paths exposed from that source repository. This prevents a consumer from accidentally pinning packages from one source repository to different revisions and makes routine revision advances smaller and more reviewable.

Example shape:

```json
{
  "schemaVersion": 3,
  "cargo": {
    "localOnly": true,
    "repositories": [
      {
        "git": "https://github.com/example/foundation.git",
        "rev": "0123456789abcdef0123456789abcdef01234567",
        "localPath": "../foundation",
        "packages": [
          { "package": "example-media-core", "path": "crates/media/media-core" },
          { "package": "example-runtime-core", "path": "crates/runtime/runtime-core" }
        ]
      }
    ]
  }
}
```

Schema versions 1 and 2 remain supported. A schema-v3 migration changes declaration structure only; it does not authorize a new source revision, package publication, or registry-coordinate change.

The versioned schemas are intentional safety behavior. Older tooling must reject a newer contract it cannot interpret rather than silently discarding local-only or repository-level semantics.

## Exact transitive graph

Direct revision checks are not enough once a source dependency has source dependencies of its own. A root consumer can otherwise override the revision against which an intermediate repository was developed without making that disagreement explicit.

Run:

```sh
coding-tooling source-deps verify-graph --json
```

The verifier recursively follows available exact local source checkouts and their `.coding-tooling.source-deps.json` files. It checks local `HEAD` against each declared revision and groups every expectation by canonical source repository. If two consumers in the resolved graph require the same repository at different revisions, verification fails with `source-graph-revision-conflict` instead of silently accepting the root override.

The verifier is deliberately evidence-only. It does not choose which conflicting revision should win. Advancing an intermediate dependency remains an implementation decision that needs the normal affected validation.

## Fleet reconciliation

A fleet can inspect legacy declarations and plan repository-level schema-v3 migrations with:

```sh
coding-tooling fleet source-deps reconcile --root .. --json
```

Use `--apply` to write only safe migrations:

```sh
coding-tooling fleet source-deps reconcile --root .. --apply --json
```

Reconciliation preserves every already-declared exact revision. It resolves package paths back to their Git repository root, groups packages by source repository, and emits one repository-level pin. Any transitive revision conflict, invalid source declaration, or source repository that cannot be resolved blocks the fleet mutation. It never resolves a conflict by selecting the newest commit.

The mutation is deterministic and idempotent. Once eligible repositories are on schema v3, repeating `--apply` reports zero changed repositories.

## Local workspace responsibility

`localOnly` is the preferred mode for agent-managed multi-repository workspaces. The agent or outer coding loop is responsible for checking out the required repositories/worktrees at the declared revisions before activation. This keeps repository authentication outside the dependency resolver and avoids turning GitHub Actions credentials into part of the development contract.

When a sibling checkout exists, coding-tooling requires its `HEAD` to equal the declared revision before generating a path patch. This makes local agent work fast without silently accepting a different source revision.

Schema-version-1 configs remain supported for intentional local-or-Git workflows: coding-tooling uses a matching sibling checkout when present and otherwise renders an exact Git revision patch.

## Distribution boundary

The generated Cargo configuration is development infrastructure. Do not edit it by hand and do not use source mode as release evidence. Release verification must deactivate source mode and prove registry-only resolution in a clean checkout.

During ordinary development, upstream package versions should remain compatible with the consumer's declared registry requirement. Version bumps belong to a dedicated release change after the source graph has already been proven. This prevents feature work from turning into a transitive publication wave.

When `coding-tooling pr integrate` evaluates a synthetic merge with a schema-version-2-or-3 `localOnly` source graph, it treats that integration as source development. Source-development integration may refresh the temporary source graph instead of enforcing the distribution lockfile with `--locked`; the integrator restores the caller's Cargo lockfiles before its tracked-mutation check. It activates the exact sibling sources, requires a successful `source-development` environment fingerprint receipt, runs the selected local validation tier against that graph, and then restores generated Cargo source configuration and Cargo lockfiles before checking for other tracked mutations. Repositories without `localOnly: true` keep the existing integration behavior.

Source mode is intentionally narrow: it changes dependency resolution only. It does not decide which repositories an agent may modify, publish packages, bump versions, or create releases.
