# Deterministic convergence

`coding-tooling converge` repeatedly applies only remediation that is already mechanically proven safe, normalizes the resulting code to a deterministic local fixed point, and returns any remaining semantic or repository-state work as an explicit handoff.

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
  -> fast verification
  -> integration verification when applicable
  -> workflow integration verification when applicable
  -> end-to-end verification when requested and applicable
  -> repository merge readiness
  -> open pull-request reconciliation
  -> converged or explicit handoff
```

By default only active new findings participate. Existing baseline debt requires `--include-baseline`.

```bash
coding-tooling converge --json
coding-tooling converge --include-baseline --json
coding-tooling converge --verify-tier e2e --json
coding-tooling converge --no-verify --json
```

The normalization phase is always local and precedes verification. It uses only closed mutation adapters and accepts the result only when a complete second normalization pass is a content no-op. See `docs/normalization.md`.

The default verification target is `fast` and is executed in strict mode after deterministic scaffolding and normalization reach a fixed point. For the built-in progressive targets, `--verify-tier` is a verification ceiling rather than an isolated test selection:

```text
fast
integration -> fast, integration
workflow    -> fast, integration, workflow
e2e         -> fast, integration, workflow, e2e
```

`test:integration` is intended for endpoint/component integration. `test:integration:workflow` is the separate extended integration layer for multi-operation or business-workflow behavior that still does not require a browser or full external system surface.

A progressive layer with no planned checks and no required missing capability is recorded as `not-applicable` and does not block promotion. A layer that the repository requires but cannot execute still fails closed. Promotion stops at the first applicable non-passing layer. `full` remains a direct aggregate tier for compatibility, and custom tier names also keep exact-tier behavior rather than being guessed into the built-in ladder.

When semantic findings remain after the deterministic fixed point, convergence runs only the cheap first progressive layer and returns the remaining semantic work as a handoff. It does not spend integration or E2E work before source convergence is complete.

Validation remains separate from mutation: unsupported normalization surfaces, non-fixable lint findings, type errors, failing tests, and build failures are still reported by the normal validation path rather than being guessed into edits.

A clean source fixed point is exposed separately as `sourceFixedPoint`. It is not enough for the overall result to be `converged`: required verification promotion must also succeed. A verification failure therefore keeps `sourceFixedPoint: true` while resolving the overall convergence result to `partial`.

For a real Git worktree, a verified clean fixed point is not called `converged` until repository-level evidence also agrees. `repositoryMergeReadiness()` must classify the repository as `trusted-auto-merge`, or as a clean intentional `local-gated` repository. `not-ready`, `protection-required`, or a `local-gated` state that still carries governance blockers turns the result into `partial` rather than treating source-tree cleanliness as repository convergence. Repository readiness and PR reconciliation run only after required verification has passed.

The final pull-request reconciliation pass is also read-only. Ordinary active pull requests and intact stacks do not block convergence. An open pull request requires reconciliation when GitHub can prove that its non-default base was the head of an already merged parent pull request, or when GitHub reports a true base conflict. A legitimate non-default base with no merged-parent evidence, and a merely behind pull request, are reported as refresh advice without blocking convergence. Missing GitHub query evidence fails closed instead of being interpreted as an empty pull-request graph.

## Result states

- `converged` — no active findings remain in the selected debt scope after normalization, required progressive verification has passed or was genuinely non-applicable, repository merge readiness is acceptable, and the open pull-request graph has no reconciliation blockers.
- `partial` — no more deterministic scaffolds are available and normalization is stable, but findings, verification blockers, merge-readiness blockers, or open pull-request reconciliation work remain.
- `blocked` — a deterministic scaffold failed, normalization failed or was non-idempotent, repository/finding state stopped making progress, a previous state reappeared, or the bounded scaffold-round limit was reached.

`partial` is a successful deterministic fixed point, not a claim that implementation is complete. The `handoff` field contains remaining source remediation candidates. `verifications` records each attempted validation layer and whether it was applicable. `repositoryReadiness`, `pullRequestReconciliation`, and `convergenceBlockers` expose the final repository-state evidence separately so agents do not have to infer governance or PR-topology work from source findings. The `normalizations` field records each normalization fixed-point attempt performed during the convergence run.

## Deployment runtime parity

Repository findings include `deployment-runtime-parity` for a deliberately narrow class of Pages divergence. When a Pages workflow explicitly changes the runtime build with a production-only public environment variable such as `VITE_*`, `NEXT_PUBLIC_*`, `NUXT_PUBLIC_*`, `PUBLIC_*`, or `REACT_APP_*`, or builds under an explicit deployment `--base`, coding-tooling expects browser/runtime validation to consume a produced artifact before deployment.

This is structural evidence only. It does not execute the site, require browser tests for ordinary static Pages builds, or claim that every custom deployment framework has been understood. Its purpose is to catch the proven failure mode where development-server smoke exercises one program while the deployed artifact enables a materially different runtime path.

The strongest supported shape is:

```text
production build
  -> immutable artifact
  -> browser/runtime verification of that artifact
  -> deployment of the same verified artifact
```

A repository can satisfy the detector with reusable prebuilt-artifact validation or an equivalent explicit artifact download plus browser/runtime test wiring.

## Convergence properties

The design borrows the useful fixed-point ideas often associated with convergent replicated systems without pretending that a repository worktree is a CRDT:

- finding identities are stable and regenerated from repository state;
- generator/scaffold application is idempotent and collision-safe;
- normalization order is deterministic and its second pass must be a no-op;
- every mechanical phase is re-observed from current repository state rather than replayed from stale plans;
- normalization may expose new deterministic scaffold work, in which case convergence re-enters the scaffold phase;
- repeated fingerprints of repository content plus finding state detect true oscillation without mistaking a legitimate normalized rewrite for a cycle;
- a scaffold round that changes neither repository content nor finding state fails closed;
- generated application files immediately become ordinary user-owned repository code;
- verification promotes from cheaper/local evidence toward stronger integration evidence and stops on the first applicable failure;
- external repository evidence is checked only after required verification at the final convergence boundary and never used as permission to mutate source mechanically.

The system does not require generator operations to commute. When two deterministic mutations conflict, the collision is evidence that the state cannot be merged mechanically and convergence stops.

## Structured implementation markers

Generators can leave exact semantic work for an agent with this deliberately small comment syntax:

```text
TODO: [coding-tooling:<stable-key>] <implementation instruction>
```

For example:

```ts
// TODO: [coding-tooling:create-order-handler] Implement the declared create-order behavior through the repository abstraction.
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
  -> fast verification
  -> stronger applicable integration layers
  -> fixed point or another explicit handoff
```

The existing Bun missing-test scaffold follows this model. It may create the mechanical test file and a `test.todo`, but it also writes a deterministic structured marker instructing the agent to replace the placeholder with meaningful assertions. The original structural missing-test finding disappears; the semantic work-marker finding remains until the test is actually implemented.

The marker is not generator ownership metadata. Once generated, the file belongs to the repository and may be edited normally. Convergence observes current evidence; it never tries to synchronize application source back to a newer template.

Marker keys should be deterministic for generator-authored work and stable for the lifetime of that work item. The syntax remains intentionally line-oriented and does not become a general annotation or workflow language.
