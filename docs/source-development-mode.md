# Source development mode

Source development mode keeps package publication out of the ordinary implementation loop.

A consumer repository commits `.coding-tooling.source-deps.json` with the exact source revisions that temporarily replace registry packages. `coding-tooling source-deps activate` materializes a managed `.cargo/config.toml` containing Cargo `[patch.crates-io]` entries. `status` reports whether that managed configuration is active and `deactivate` removes it.

Each patch declares the package name, source repository URL, exact Git revision, and optionally a sibling checkout path. When the sibling checkout exists, coding-tooling requires its `HEAD` to equal the declared revision before using the local path. This makes local agent work fast without silently accepting a different source revision.

For private cross-repository development, set `cargo.localOnly` to `true`. Every patch must then declare `localPath`, the sibling checkout must exist, and its `HEAD` must match the pinned revision. Missing local source is an error: coding-tooling never falls back to an authenticated Git fetch in local-only mode. The source repository URL is retained only as provenance for the pinned dependency.

`localOnly` is the preferred mode for agent-managed multi-repository workspaces. The agent or outer coding loop is responsible for checking out the required repositories/worktrees at the declared revisions before activation. This keeps repository authentication outside the dependency resolver and avoids turning GitHub Actions credentials into part of the development contract.

When `cargo.localOnly` is omitted or false, the previous behavior remains available: coding-tooling uses a matching sibling checkout when present and otherwise renders an exact Git revision patch. This is useful for public source repositories and other environments where remote source access is intentionally part of the workflow.

The generated Cargo configuration is development infrastructure. Do not edit it by hand and do not use source mode as release evidence. Release verification must deactivate source mode and prove registry-only resolution in a clean checkout.

During ordinary development, upstream package versions should remain compatible with the consumer's declared registry requirement. Version bumps belong to a dedicated release change after the source graph has already been proven. This prevents feature work from turning into a transitive publication wave.

Source mode is intentionally narrow: it changes dependency resolution only. It does not decide which repositories an agent may modify, publish packages, bump versions, or create releases.
