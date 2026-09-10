# Deterministic convergence

`coding-tooling converge` repeatedly applies only remediation that is already mechanically proven safe, then stops at a fixed point and returns any remaining work as an explicit agent handoff.

It is not an autonomous implementation loop. It does not decide what feature should exist, invent business behavior, suppress findings, accept baselines, overwrite collisions, or ask an LLM to repair code.

## Loop

```text
findings
  -> remediation candidates
  -> deterministic scaffolds only
  -> findings again
  -> repeat while the finding state changes
  -> strict validation
  -> converged or agent handoff
```

By default only active new findings participate. Existing baseline debt requires `--include-baseline`.

```bash
coding-tooling converge --json
coding-tooling converge --include-baseline --json
coding-tooling converge --verify-tier full --json
coding-tooling converge --no-verify --json
```

The default verification tier is `fast` and is executed in strict mode after deterministic mutation reaches a fixed point. Validation remains separate from the convergence result: a repository can reach a structural fixed point and still fail formatting, linting, typechecking, tests, or build validation.

## Result states

- `converged` — no active findings remain in the selected debt scope.
- `partial` — no more deterministic scaffolds are available, but findings remain for an agent or human to resolve.
- `blocked` — a deterministic scaffold failed, the finding state stopped making progress, a previous state reappeared, or the bounded round limit was reached.

`partial` is a successful deterministic fixed point, not a claim that implementation is complete. The `handoff` field contains the remaining remediation candidates with stable finding IDs, subjects, related files, and verification commands.

## Convergence properties

The design borrows the useful fixed-point ideas often associated with convergent replicated systems without pretending that a repository worktree is a CRDT:

- finding identities are stable and regenerated from repository state;
- generator/scaffold application is idempotent and collision-safe;
- mutation order is deterministic;
- every round is re-observed from current repository state rather than replayed from stale plans;
- repeated finding-state fingerprints detect oscillation;
- a round that changes no finding state fails closed;
- generated application files immediately become ordinary user-owned repository code.

The system does not require generator operations to commute. When two deterministic mutations conflict, the collision is evidence that the state cannot be merged mechanically and convergence stops.

## Generated implementation markers

Generators may deliberately create compiling structures that contain ordinary `TODO`/`FIXME` markers. The existing `source-debt-marker` expectation then exposes those markers as residual findings. This creates a useful handoff boundary:

```text
generator materializes declared structure
  -> findings expose implementation marker
  -> converge returns partial + exact related file
  -> agent implements semantics and removes marker
  -> formatter/linter/typechecker/tests provide deterministic verification
  -> converge is rerun against the new state
```

The marker is not generator ownership metadata. Once generated, the file belongs to the repository and may be edited normally. Convergence observes current evidence; it never tries to synchronize application source back to a newer template.

A future refinement can define a structured coding-tooling TODO marker with a stable marker key so multiple generated implementation sites in one file can become separate deterministic work items. That should remain a small syntax contract rather than a general annotation language.
