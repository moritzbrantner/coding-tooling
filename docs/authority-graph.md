# Fleet authority graph

The fleet authority graph is a read-only projection of repository dependencies and repository-local semantic authority declarations.

```sh
coding-tooling fleet authority-graph --root .. --json
```

It is intentionally descriptive. It helps humans and agents discover where responsibilities are declared; it does not prove that an architecture is correct and it is not a validation or merge gate.

## Dependency source

Repository relationships come from the existing `.repository.toml` contract. `depends_on` remains the repository-local declaration for dependency direction.

Source-development checkout verification is deliberately outside this graph. Use the explicit source-dependency and environment commands when exact revisions or local checkout state need verification.

## Authority source

Repository-specific semantic ownership belongs in `AGENTS.md`, because the owner and permitted projections differ by repository. Use this section when a repository has domain semantics that another process, UI, simulator, adapter, or repository could otherwise accidentally redefine:

```md
## Authority boundaries

- Owns: `physics/collision`, `physics/contact-response`
- Adapts: `game-server/lobby-control`
- Non-authoritative: `balance-simulation`
- Prohibited write-back: browser projection must not become authoritative simulation state
```

`Owns`, `Adapts`, and `Non-authoritative` accept comma-separated stable capability names. `Prohibited write-back` records a human-readable directional boundary.

## Descriptive conflicts and gaps

Two repositories declaring the same `Owns` capability are returned in `conflicts` and the compatibility `duplicateOwners` field. The graph still returns `passed`; resolving the conflict is an architecture decision, not something the graph should make.

A missing authority section is reported under coverage as an adoption gap. Not every repository has a meaningful semantic-authority boundary, and adoption should not require invented ownership statements.

Adapters whose owner is not visible in the scanned fleet remain visible without being treated as invalid; the authoritative capability may be external to the current fleet root.

## Published landscape

The coding-tooling Pages deployment builds a best-effort public snapshot from repository-local `.repository.toml` and `AGENTS.md` files:

- `/landscape.html` is the searchable human view.
- `/landscape.json` is the static machine-readable snapshot.

The snapshot is a projection only. Repository-local files remain authoritative, collection failures are surfaced as warnings, and a partial snapshot does not block deployment.
