# Fleet authority graph

The fleet authority graph combines repository dependency metadata with repository-local semantic authority declarations.

```sh
coding-tooling fleet authority-graph --root .. --json
```

## Dependency source

Repository relationships come from the existing `.repository.toml` contract. `depends_on` remains the authoritative declaration for repository dependency direction.

When `.coding-tooling.source-deps.json` exists, the graph also exposes each exact source-development revision. Local source checkouts are inspected and their actual Git SHA is compared with the committed revision. Revision drift fails the graph instead of silently describing a different source graph.

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

## Failure semantics

Two repositories declaring the same `Owns` capability is a deterministic failure. A configured local source checkout at a different revision from its committed source dependency is also a failure.

A missing authority section is reported as an adoption gap rather than failing the fleet. Not every repository has a meaningful semantic-authority boundary, and adoption should not require invented ownership statements.

Adapters whose owner is not visible in the scanned fleet remain visible without being treated as automatically invalid; the authoritative capability may be external to the current fleet root.
