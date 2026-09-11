# Workspace toolchain evidence

GitHub Pages remote preflight may inherit a package toolchain identity from the repository root only when the root manifest directly proves workspace membership.

Supported workspace declarations are the `workspaces: [...]` array form and the `workspaces: { packages: [...] }` object form. Remote preflight intentionally recognizes only simple `*`, `**`, and `?` path patterns. Unsupported glob syntax does not establish membership.

For a proven workspace member:

- an absent member-local toolchain pin may inherit a satisfied root toolchain identity;
- inherited command capabilities use the workspace owner's package command manager;
- an explicit satisfied member identity that differs from the root identity is a workspace conflict;
- explicit non-exact, unsupported, or independently evidenced toolchains are not hidden by inheritance.

This keeps workspace ownership deterministic without requiring redundant package-manager declarations in every member manifest.
