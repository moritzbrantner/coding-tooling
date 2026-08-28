# Dependency architecture audit

`coding-tooling dependencies audit` checks repository-level coupling separately from package-manager correctness.

Use it when a repository participates in a multi-repository capability landscape and package manifests alone do not express whether a dependency direction is architecturally intended.

## Configuration

Create `.coding-tooling.dependencies.json` from `.coding-tooling.dependencies.example.json`.

Required repository layers:

- `foundation` — neutral contracts/primitives; must not depend upward on domain/application implementations.
- `domain` — focused capabilities such as audio, NLP, or visual analysis.
- `adapter` — explicit cross-domain integration allowed to know both sides.
- `application` — composition root; may use several domain capabilities.
- `tooling` — development/runtime tooling that is outside the domain layering rule.

Dependencies declare the target repository layer and a relationship. `relation: "adapter"` is the explicit escape hatch for justified domain-to-domain integration; do not use it simply to silence a warning.

## Command

```bash
coding-tooling dependencies audit --json
coding-tooling dependencies audit --strict --json
```

The audit also reads `.coding-tooling.source-deps.json` when present. Exact source overrides therefore become visible architecture evidence instead of invisible local mechanics.

## Checks

The first version reports:

- foundation dependencies that point upward;
- unapproved domain-to-domain implementation dependencies;
- domain/adapter dependencies on applications;
- exact source repositories that are not declared in the architecture config;
- source patches that still target a configured legacy repository after a canonical owner exists;
- exact source workspaces spanning more than the configured repository budget (default: two upstream repositories);
- applications that source-patch too many packages from one repository, indicating that upstream package topology is leaking through the capability boundary;
- versioned packages whose canonical source and release repositories differ;
- cycles in an optional declared repository graph.

Errors fail the command. Architecture smells that may be intentional are warnings; `--strict` promotes warnings to a failing result.

## Interpretation

The goal is not to minimize dependency count mechanically. An application may legitimately compose many independently versioned capabilities. The audit instead asks whether the dependency direction and ownership are understandable without treating several repositories as one implicit workspace.

Likewise, exact source overrides remain useful for deliberate cross-repository development. A wide permanent patch graph is the problem, not the existence of a source-development mechanism.

Repository-local checks may still enforce more specific boundaries—for example, ensuring transport crates depend on an application core rather than directly on media implementations. `coding-tooling dependencies audit` provides the reusable landscape-level layer beneath those focused checks.
