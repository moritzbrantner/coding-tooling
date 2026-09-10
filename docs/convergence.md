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

## Structured implementation markers

Generators can leave exact semantic work for an agent with this deliberately small comment syntax:

```text
TODO(coding-tooling:<stable-key>): <implementation instruction>
```

For example:

```ts
// TODO(coding-tooling:create-order-handler): Implement the declared create-order behavior through the repository abstraction.
```

`source-work-marker` emits one finding per marker. Each finding keeps the marker key, instruction, file, and line instead of grouping every TODO in a file into one vague debt item. Structured markers are recognized in ordinary source and test source. The generic `source-debt-marker` detector deliberately excludes them so they are not double-counted.

This creates the intended handoff boundary:

```text
generator materializes declared structure
  -> structured marker names the remaining semantic work
  -> findings expose the exact marker/file/line
  -> converge returns partial + agent handoff
  -> agent implements semantics and removes the marker
  -> formatter/linter/typechecker/tests provide deterministic verification
  -> converge is rerun against the new state
```

The existing Bun missing-test scaffold now follows this model. It may create the mechanical test file and a `test.todo`, but it also writes a deterministic structured marker instructing the agent to replace the placeholder with meaningful assertions. The original structural missing-test finding disappears; the semantic work-marker finding remains until the test is actually implemented.

The marker is not generator ownership metadata. Once generated, the file belongs to the repository and may be edited normally. Convergence observes current evidence; it never tries to synchronize application source back to a newer template.

Marker keys should be deterministic for generator-authored work and stable for the lifetime of that work item. The syntax remains intentionally line-oriented and does not become a general annotation or workflow language.
