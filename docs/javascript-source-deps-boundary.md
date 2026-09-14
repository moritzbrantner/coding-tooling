# JavaScript source-dependency boundary

The shared JavaScript source-development mechanism is intentionally narrower than package management.

- `.coding-tooling.source-deps.json` is the durable declaration of exact source repositories and package identities.
- `coding-tooling source-deps prepare` validates exact local revisions, starts from the frozen ordinary install, builds configured packages in dependency order, and materializes them under their real package names.
- Source-to-source dependencies are derived from package manifests. A downstream source package is built with already-built configured source dependencies overlaid into its repository-local `node_modules`.
- `node_modules/.coding-tooling-source-deps` is ephemeral evidence only. Source paths and revisions must not enter runtime state, persisted documents, or release metadata.
- `coding-tooling source-deps smoke` verifies the materialized package identities and root imports.
- `coding-tooling source-deps restore` removes source materializations and re-establishes the frozen ordinary install.
- JavaScript schema-v4 source resolution is local-only. Checkout/authentication remains the responsibility of the outer workspace or CI transport layer.
- Publication, version selection, release readiness, and package-registry policy remain separate concerns.

This keeps source-first implementation fast without making source checkouts the distributable dependency contract.
