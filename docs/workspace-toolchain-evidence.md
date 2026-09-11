# Workspace toolchain evidence

GitHub Pages remote preflight may inherit a package toolchain identity from the repository root only when the root manifest directly proves workspace membership.

Supported workspace declarations are the `workspaces: [...]` array form and the `workspaces: { packages: [...] }` object form. Remote preflight intentionally recognizes only simple literal paths plus `*`, `**`, and `?` path patterns. Unsupported glob syntax does not establish membership. A declaration containing an exclusion pattern fails closed until exclusion semantics can be proven rather than silently ignoring the exclusion. A slash-adjacent `**/` may consume zero directory segments, matching ordinary globstar semantics.

For a proven workspace member:

- an absent member-local toolchain pin may inherit a satisfied root toolchain identity;
- inherited command capabilities use the workspace owner's package command manager;
- an explicit satisfied member identity that differs from the root identity is a workspace conflict;
- explicit non-exact, unsupported, or independently evidenced toolchains are not hidden by inheritance.

Validation evidence remains component-scoped. A root-level `bun run lint` does not prove the same script for a nested workspace member. Remote preflight requires a literal matching working directory, or an equivalent explicit directory change, before using a member command as hosted validation evidence.

This keeps workspace ownership deterministic without requiring redundant package-manager declarations in every member manifest or letting one component's validation stand in for another's.
