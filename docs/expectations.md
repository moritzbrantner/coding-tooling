# Repository expectations

`coding-tooling` can deterministically inspect a partially built repository for missing puzzle pieces. Expectations complement generators: generators create known structure up front, while expectations audit existing structure and expose what is absent.

The trusted finding stream is deliberately deterministic. It does not use an LLM, modify source files while inspecting, or claim behavioral correctness from weak evidence.

## Commands

```sh
coding-tooling findings
coding-tooling findings --new
coding-tooling findings --baseline
coding-tooling findings --all
coding-tooling finding CT-0123456789AB
coding-tooling baseline
coding-tooling scaffold CT-0123456789AB
```

`findings` and `finding` are read-only. `findings --all` also exposes suppressed findings. `baseline` writes the current active finding IDs to `.coding-tooling.expectations.json`. `scaffold` is an explicit mutation and is available only when a finding has a deterministic boilerplate action.

## Versioned detector registry

Every deterministic expectation is registered with an ID and a contract version. Findings carry `expectationId`, `expectationVersion`, `policyKind`, and an optional `conventionId` for convention-backed detectors.

Semantic finding IDs are derived from the expectation ID and contract version plus the semantic subject and required condition. Unrelated edits and line-number changes therefore do not renumber findings. A detector implementation can be fixed without changing its contract version, while an intentional semantic contract change can increment the version and deliberately invalidate old finding IDs.

The built-in completeness detectors are advisory evidence by default. They become blocking only through explicit repository enforcement. This keeps detector mechanics in `coding-tooling` without turning the implementation into an independent hidden policy source.

## Initial expectations

The first batch covers several kinds of structural absence:

- `typescript-source-test`: a TypeScript source file in a package with a test command has neither a conventionally matching test artifact nor a test that directly imports the source module.
- `package-aggregate-check`: a package exposes multiple verification scripts but no aggregate `check` or `verify` script.
- `typescript-project-config`: a package contains TypeScript source but no `tsconfig.json`.
- `package-cli-wiring`: a CLI entrypoint is not wired through `package.json`, or configured bin wiring points to a missing file.
- `required-capability-available`: `.coding-tooling.json` declares a required capability that no discovered component provides.

The TypeScript test expectation is structural, not a claim about behavioral coverage. A matching test artifact or conservative direct test import satisfies the current contract. A Bun lockfile alone does not imply the Bun test runner: a `bun:test` scaffold is offered only when the configured test script actually invokes `bun test`. Other test runners receive a verification hint but no guessed framework-specific scaffold.

## Persistent metadata

`.coding-tooling.expectations.json` contains only deliberate repository policy and accepted debt:

```json
{
  "schemaVersion": 1,
  "baseline": [],
  "suppressions": [],
  "invariants": [],
  "enforcement": {}
}
```

A suppression must include a reason and identify either one finding ID or an expectation, optionally narrowed to a semantic subject. Invariants are explicit repository knowledge for agents; the analyzer does not synthesize them.

Persistent metadata is reconciled against the current deterministic finding stream. Reports identify orphaned baseline IDs, stale suppressions, duplicate metadata, and references to unknown expectation IDs so accepted debt does not silently become a graveyard.

## Finding lifecycle

Findings have two independent lifecycle dimensions:

- `state: "new" | "baseline"` describes whether active debt has been accepted into the current baseline.
- `disposition: "active" | "suppressed"` describes whether the finding is intentionally excluded from normal active output.

Normal `findings` output hides suppressed findings, preserving the existing operational view. `findings --all` and `finding <id>` keep them inspectable together with the suppression reason. Baselining does not hide debt: active findings remain visible with `state: "baseline"`.

Only an active, new finding promoted to `error` makes `findings` fail. Re-running `baseline` rewrites the baseline from the current active finding set, so resolved debt disappears.

## Agent-facing contract

Each finding contains:

- a stable semantic ID and versioned expectation identity;
- policy provenance, severity, baseline state, and disposition;
- a semantic subject and missing requirement;
- deterministic evidence and related files;
- focused verification commands when derivable;
- deterministic relationships to other findings when known;
- an optional explicit scaffold action.

`coding-tooling finding CT-... --json` deterministically reports whether one finding is `active`, `suppressed`, or `absent`. This lets an orchestrator revalidate a work item without rediscovering repository context.

Task management remains outside `coding-tooling`. A coordinator may persist a relationship such as `TASK-123 -> CT-0123456789AB`, but `coding-tooling` owns only whether the finding currently exists and what deterministic evidence supports it.

## Scaffolding boundary

Finding scaffolds do not maintain a separate mutation engine. They are converted to a generator plan and applied through the shared generator mutation machinery, inheriting its conflict handling, idempotency, rollback behavior, and repository-path safety. The finding is re-analyzed afterward; scaffolding succeeds only when the original finding is no longer active.

The shared generator path rejects symbolic-link components in existing output paths so repository-local paths cannot cause a scaffold or structured update to follow a symlink outside the repository.

## Analysis cost

Expectations should use the cheapest deterministic source that can prove the fact: filesystem/manifests first, repository configuration next, then static/AST or compiler metadata only for rules that need it. Probabilistic local-agent analysis should remain a separate enrichment layer until there is evidence that it belongs in the trusted finding stream.
