# Source development mode

Source development mode keeps package publication out of the ordinary implementation loop.

A consumer repository commits `.coding-tooling.source-deps.json` with the exact source revisions that temporarily replace ordinary dependencies. `coding-tooling source-deps prepare` (an alias for `activate`) enables the declared source graph, `status` reports it, `smoke` verifies active JavaScript package identities, and `restore` (an alias for `deactivate`) returns to the ordinary install.

## Source contracts

Schema version 1 is the original local-or-Git Cargo format. Each Cargo patch declares its package, source repository URL, exact Git revision, and optional sibling package path.

Schema version 2 adds `cargo.localOnly: true`. Every patch must then declare `localPath`, the sibling checkout must exist, and its `HEAD` must match the pinned revision. Missing local source is an error: coding-tooling never falls back to an authenticated Git fetch in local-only mode. The source repository URL remains provenance rather than a hidden network fallback.

Schema version 3 keeps the same Cargo behavior but moves the exact revision to the repository boundary. One repository entry declares `git`, `rev`, an optional repository-level `localPath`, and the package names plus package-relative paths exposed from that source repository. This prevents a consumer from accidentally pinning packages from one source repository to different revisions and makes routine revision advances smaller and more reviewable.

Schema version 4 retains the repository-level Cargo contract and adds JavaScript/Bun source packages. JavaScript source repositories are local-only: each repository declares an exact 40-character revision, a sibling `localPath`, and one or more real package identities. Package-relative `path` is optional for monorepositories.

Example shape:

```json
{
  "schemaVersion": 4,
  "cargo": {
    "repositories": []
  },
  "javascript": {
    "localOnly": true,
    "repositories": [
      {
        "git": "https://github.com/example/editor-core.git",
        "rev": "0123456789abcdef0123456789abcdef01234567",
        "localPath": "../editor-core",
        "packages": [{ "package": "@example/editor-core" }]
      },
      {
        "git": "https://github.com/example/timeline-editor.git",
        "rev": "89abcdef0123456789abcdef0123456789abcdef",
        "localPath": "../timeline-editor",
        "packages": [{ "package": "@example/timeline-editor" }]
      }
    ]
  }
}
```

For JavaScript source mode, coding-tooling starts from the consumer's frozen ordinary install, validates every sibling checkout against its declared revision, derives configured source-to-source dependencies from package manifests, builds packages in deterministic dependency order, and overlays already-built source packages while building downstream source packages. It then materializes each package into the consumer's `node_modules` under its real package identity. Package `files` entries must be concrete paths; packages without `files` default to `dist`.

JavaScript source state is ephemeral under `node_modules/.coding-tooling-source-deps`. `restore` removes those materializations and runs the frozen ordinary install again. Source paths and source revisions therefore remain development evidence rather than runtime or persisted application state.

## Distribution-wrapper upstreams (schema version 5)

Some JavaScript packages are distribution wrappers: their build produces the published artifact from another repository's source (for example a WASM wrapper that compiles a Rust upstream). Schema version 4 can only materialize a wrapper as a whole, so the wrapper's build would still fetch its upstream instead of using a local checkout.

Schema version 5 is schema version 4 plus an optional `upstreams` array on a JavaScript source repository. Each upstream declares:

- `env`: an `UPPER_SNAKE` environment variable name. Names that steer the toolchain (`PATH`, `HOME`, `TMPDIR`, `CI` and similar, and any name starting with `BUN_`, `NODE_`, `NPM_`, `YARN_`, `PNPM_`, `GIT_`, `LD_`, `DYLD_`, `CARGO_`, `RUST`, `XDG_`, `LC_` or `SSH_`) are refused.
- `git`: the upstream repository URL, as provenance. It must differ from the wrapper repository and from the wrapper's other upstreams.
- `rev`: the exact 40-character upstream revision.
- `localPath`: the upstream checkout, relative to the consumer repository (absolute paths are refused). It must not resolve to the consumer or wrapper checkout.
- `revisionField` (optional): a dotted path in the wrapper repository's root `package.json`, for example `nlpStack.commit`, whose string value must equal `rev`.

Unknown upstream fields, duplicate `env` names and an empty `upstreams` array are refused. Schema version 4 refuses `upstreams` so older contracts cannot silently gain build-input semantics.

```json
{
  "schemaVersion": 5,
  "cargo": { "repositories": [] },
  "javascript": {
    "localOnly": true,
    "repositories": [
      {
        "git": "https://github.com/example/core-wasm.git",
        "rev": "0123456789abcdef0123456789abcdef01234567",
        "localPath": "../core-wasm",
        "packages": [{ "package": "@example/core-wasm" }],
        "upstreams": [
          {
            "env": "CORE_SOURCE_DIR",
            "git": "https://github.com/example/core.git",
            "rev": "89abcdef0123456789abcdef0123456789abcdef",
            "localPath": "../core",
            "revisionField": "core.commit"
          }
        ]
      }
    ]
  }
}
```

Before any install or build, `activate` checks every upstream: the checkout must exist locally (it is never fetched), its `HEAD` must equal `rev`, and the wrapper's `revisionField` must equal `rev`. Every command coding-tooling runs in the wrapper repository (the frozen install, including lifecycle scripts, the `build` script and the restoring install) then receives `env` set to the absolute path of the upstream checkout. The active upstreams are recorded in the ephemeral source state (state schema 2), and `status` and `smoke` report each upstream's expected and active revision. Nothing is written to the upstream checkout, so `restore` only removes the materialized packages and reinstalls as before.

### Wrapper env contract

A wrapper package that supports local upstream development implements this contract:

1. When the declared variable (for example `CORE_SOURCE_DIR`) is set and non-empty, the build reads the upstream source from that absolute path and must not fetch, clone or check out the upstream. It must not modify the directory either; build output belongs in the wrapper's own tree.
2. When the variable is unset, the build keeps its ordinary behavior, typically fetching the upstream at the revision pinned in the wrapper's `package.json`.
3. The wrapper keeps its own upstream pin (the field named by `revisionField`). coding-tooling refuses to activate when that pin and the declared revision disagree, so a consumer cannot build a wrapper against an upstream revision the wrapper has not adopted.
4. Every build path that runs during `bun install` (such as `prepare`) and `bun run build` honours the variable, because coding-tooling sets it for both.

Schema versions 1 through 4 remain supported. A schema migration changes declaration structure only; it does not authorize a new source revision, package publication, or registry-coordinate change.

The versioned schemas are intentional safety behavior. Older tooling must reject a newer contract it cannot interpret rather than silently discarding local-only, repository-level, or JavaScript semantics.

## Cargo patch sections and activation check

Cargo applies a `[patch]` table per dependency source, so `activate` writes each declared Cargo package under the section that matches how the consumer actually depends on it:

- coding-tooling reads the consumer's root `Cargo.toml` and its workspace members. Members come from the `workspace.members` globs (`*`, `?`, `**` and `[...]` classes) minus `workspace.exclude`. It inspects `[dependencies]`, `[dev-dependencies]` and `[build-dependencies]`, plus their `[target.<cfg>.*]` variants, and it honours `package = "..."` renames.
- A `key = { workspace = true }` entry resolves through `[workspace.dependencies]` of the consumer's own workspace or, when the consumer root is a member of an enclosing workspace, of that workspace. Workspace entries that no inspected manifest inherits are ignored.
- When the consumer declares a source package with `git = "<url>"` and that URL matches the declared source repository canonically (case, a trailing `/` and a trailing `.git` do not matter), the package goes under `[patch."<url>"]` with the URL spelled exactly as the consumer writes it. If the consumer uses several spellings of the same repository, each spelling gets its own section.
- Every other package stays under `[patch.crates-io]`. A package that the consumer takes both from Git and from the registry is patched in both sections.
- Matching uses the URL only. The declared `rev` is the local-development revision and may be ahead of the `rev` the consumer commits; that is how a consumer tests an unpushed upstream change. Cargo cannot patch a Git source with the same repository, so a Git-declared package needs its local checkout. Without one, activation fails instead of writing a patch that has no effect.

After writing the generated config, `activate` runs `cargo metadata --format-version 1` in the consumer root. It runs offline first, so local sources and an already-filled Cargo cache need no network, and it retries online only when the offline run fails. Before the run it asks `cargo locate-project --workspace` for the workspace that owns the consumer, which can be an enclosing workspace. Afterwards it restores that workspace's `Cargo.lock`, or removes one the run created. It does this whether verification passes or fails. Every patch that resolves to a local checkout must appear in the metadata as a path package (`source: null`) whose manifest lies in that checkout, and the graph must not still contain the package from the declared Git repository. A Git-rendered patch (schema-1 local-or-Git mode without a checkout) must appear in the graph. Cargo's `Patch ... was not used in the crate graph` warning counts as a failure as well. On failure, activation reports `error` with a diagnostic naming each unused package, and the previous generated config is restored or the new one is removed. The result's `cargoVerification` field is `verified`, or `skipped` when the consumer root has no `Cargo.toml` or declares no Cargo patches.

## Exact transitive graph

Direct revision checks are not enough once a source dependency has source dependencies of its own. A root consumer can otherwise override the revision against which an intermediate repository was developed without making that disagreement explicit.

Run:

```sh
coding-tooling source-deps verify-graph --json
```

The verifier recursively follows available exact local Cargo and JavaScript source checkouts, including schema-v5 wrapper upstreams, and their `.coding-tooling.source-deps.json` files. Each upstream is an exact-revision graph node (ecosystem `javascript-upstream`) grouped with every other declaration of the same canonical repository. It checks local `HEAD` against each declared revision and groups every expectation by canonical source repository. If two consumers in the resolved graph require the same repository at different revisions, verification fails with `source-graph-revision-conflict` instead of silently accepting the root override.

The verifier is deliberately evidence-only. It does not choose which conflicting revision should win. Advancing an intermediate dependency remains an implementation decision that needs the normal affected validation.

## Fleet reconciliation

A fleet can inspect legacy Cargo declarations and plan repository-level schema-v3 migrations with:

```sh
coding-tooling fleet source-deps reconcile --root .. --json
```

Use `--apply` to write only safe migrations:

```sh
coding-tooling fleet source-deps reconcile --root .. --apply --json
```

Reconciliation preserves every already-declared exact revision. It resolves Cargo package paths back to their Git repository root, groups packages by source repository, and emits one repository-level pin. Any transitive revision conflict, invalid source declaration, or source repository that cannot be resolved blocks the fleet mutation. It never resolves a conflict by selecting the newest commit.

The mutation is deterministic and idempotent. Once eligible Cargo repositories are on schema v3, repeating `--apply` reports zero changed repositories. JavaScript schema-v4 adoption is explicit because package build and publication boundaries must be reviewed rather than inferred from Cargo metadata.

## Local workspace responsibility

`localOnly` is the preferred mode for agent-managed multi-repository workspaces. The agent or outer coding loop is responsible for checking out the required repositories/worktrees at the declared revisions before activation. This keeps repository authentication outside the dependency resolver and avoids turning GitHub Actions credentials into part of the development contract.

When a sibling checkout exists, coding-tooling requires its `HEAD` to equal the declared revision before using it. This makes local agent work fast without silently accepting a different source revision.

Schema-version-1 Cargo configs remain supported for intentional local-or-Git workflows: coding-tooling uses a matching sibling checkout when present and otherwise renders an exact Git revision patch. JavaScript source mode, including wrapper upstreams, intentionally has no network fallback in schema versions 4 and 5.

## Distribution boundary

Generated Cargo configuration and JavaScript `node_modules` materializations are development infrastructure. Do not edit them by hand and do not use source mode as release evidence. Release verification must restore ordinary dependency resolution and prove the registry/Git fallback in a clean checkout.

During ordinary development, upstream package versions should remain compatible with the consumer's declared registry or pinned Git requirement. Version bumps belong to a dedicated release change after the source graph has already been proven. This prevents feature work from turning into a transitive publication wave.

When `coding-tooling pr integrate` evaluates a synthetic merge with a schema-version-2-or-3 Cargo `localOnly` source graph, it treats that integration as source development. Source-development integration may refresh the temporary source graph instead of enforcing the distribution lockfile with `--locked`; the integrator restores the caller's Cargo lockfiles before its tracked-mutation check. Schema-v4 JavaScript integration uses the same source-dependency authority but is not yet automatically activated by `pr integrate`; consumers should run their source acceptance tier explicitly until that integration path is extended.

Source mode is intentionally narrow: it changes dependency resolution only. It does not decide which repositories an agent may modify, publish packages, bump versions, or create releases.
