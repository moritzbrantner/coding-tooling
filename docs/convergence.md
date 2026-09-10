# Deterministic convergence

`coding-tooling converge` repeatedly applies only remediation that is already mechanically proven safe, normalizes the resulting code to a deterministic local fixed point, and returns any remaining semantic work as an explicit agent handoff.

It is not an autonomous implementation loop. It does not decide what feature should exist, invent business behavior, suppress findings, accept baselines, overwrite collisions, or ask an LLM to repair code.

## Loop

```text
findings
  -> remediation candidates
  -> deterministic scaffolds only
  -> findings again
  -> repeat while mechanical work remains
  -> deterministic normalization
  -> findings again
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

The normalization phase is always local and precedes verification. It uses only closed mutation adapters and accepts the result only when a complete second normalization pass is a content no-op. See `docs/normalization.md`.

The default verification tier is `fast` and is executed in strict mode after deterministic scaffolding and normalization reach a fixed point. Validation remains separate from mutation: unsupported normalization surfaces, non-fixable lint findings, type errors, failing tests, and build failures are still reported by the normal validation path rather than being guessed into edits.

## Result states

- `converged` — no active findings remain in the selected debt scope after normalization.
- `partial` — no more deterministic scaffolds are available, normalization is stable, but findings remain for an agent or human to resolve.
- `blocked` — a deterministic scaffold failed, normalization failed or was non-idempotent, repository/finding state stopped making progress, a previous state reappeared, or the bounded scaffold-round limit was reached.

`partial` is a successful deterministic fixed point, not a claim that implementation is complete. The `handoff` field contains the remaining remediation candidates with stable finding IDs, subjects, related files, and verification commands. The `normalizations` field records each normalization fixed-point attempt performed during the convergence run.

## Convergence properties

The design borrows the useful fixed-point ideas often associated with convergent replicated systems without pretending that a repository worktree is a CRDT:

- finding identities are stable and regenerated from repository state;
- generator/scaffold application is idempotent and collision-safe;
- normalization order is deterministic and its second pass must be a no-op;
- every mechanical phase is re-observed from current repository state rather than replayed from stale plans;
- normalization may expose new deterministic scaffold work, in which case convergence re-enters the scaffold phase;
- repeated fingerprints of repository content plus finding state detect true oscillation without mistaking a legitimate normalized rewrite for a cycle;
- a scaffold round that changes neither repository content nor finding state fails closed;
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
  -> normalization canonicalizes safe mechanical output
  -> findings are regenerated
  -> formatter/linter/typechecker/tests/build verify the normalized state
  -> fixed point or another explicit handoff
```

The existing Bun missing-test scaffold follows this model. It may create the mechanical test file and a `test.todo`, but it also writes a deterministic structured marker instructing the agent to replace the placeholder with meaningful assertions. The original structural missing-test finding disappears; the semantic work-marker finding remains until the test is actually implemented.

The marker is not generator ownership metadata. Once generated, the file belongs to the repository and may be edited normally. Convergence observes current evidence; it never tries to synchronize application source back to a newer template.

Marker keys should be deterministic for generator-authored work and stable for the lifetime of that work item. The syntax remains intentionally line-oriented and does not become a general annotation or workflow language.
