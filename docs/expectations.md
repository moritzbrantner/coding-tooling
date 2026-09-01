# Repository expectations

`coding-tooling` can deterministically inspect a partially built repository for missing puzzle pieces. The same expectation model is intended to complement generators: generators create known structure up front, while expectations audit existing structure and expose what is absent.

The MVP is deliberately deterministic. It does not use an LLM, modify source files while inspecting, or infer behavioral correctness from names alone.

## Commands

```sh
coding-tooling findings
coding-tooling findings --new
coding-tooling findings --baseline
coding-tooling baseline
coding-tooling scaffold CT-0123456789AB
```

`findings` is read-only. `baseline` writes the current active finding IDs to `.coding-tooling.expectations.json`. `scaffold` is an explicit mutation and is available only when a finding has a deterministic boilerplate action.

Findings have stable semantic IDs derived from the expectation, subject, and required condition. Moving unrelated code or changing line numbers therefore does not renumber the work queue.

## Initial expectations

The first batch intentionally covers several kinds of absence instead of specializing the model around tests:

- `typescript-source-test`: a TypeScript source file in a package with a test command has no matching structural test artifact.
- `package-aggregate-check`: a package exposes multiple verification scripts but no aggregate `check` or `verify` script.
- `typescript-project-config`: a package contains TypeScript source but no `tsconfig.json`.
- `package-cli-wiring`: a CLI entrypoint is not wired through `package.json`, or configured bin wiring points to a missing file.
- `required-capability-available`: `.coding-tooling.json` declares a required capability that no discovered component provides.

These expectations are warnings by default. Repositories can explicitly promote selected expectation IDs to errors.

The TypeScript test expectation is structural, not a claim about behavioral coverage. A matching test artifact satisfies the MVP rule; deeper endpoint/test-case cardinality can be added later using deterministic AST or build metadata where justified.

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

A suppression must include a reason and identify either one finding ID or an expectation, optionally narrowed to a semantic subject.

Invariants are explicit repository knowledge for agents. They are returned with the finding report but are not guessed or synthesized by the analyzer.

## Baselines

Baselining does not hide existing debt. Findings remain visible with `state: "baseline"` so an orchestrator can still assign them to an agent. New findings have `state: "new"`.

Only a new finding promoted to `error` makes `findings` fail. A baselined error remains visible without blocking the repository. Re-running `baseline` rewrites the ledger from the currently active finding set, so resolved debt disappears instead of accumulating stale IDs.

## Agent-facing finding contract

Each finding contains:

- a semantic ID and expectation ID;
- severity and baseline state;
- a subject and missing requirement;
- deterministic evidence;
- related files;
- focused verification commands when derivable;
- deterministic relationships to other findings when known;
- an optional explicit scaffold action.

The intent is to make a finding usable as an atomic work unit. An orchestrator can hand an agent `CT-...` instead of asking it to explore the repository and rediscover where a known structural gap is located.

## Analysis cost

Expectations should use the cheapest deterministic source that can prove the fact: filesystem/manifests first, repository configuration next, then static/AST or compiler metadata only for rules that need it. Probabilistic local-agent analysis should remain a separate layer until there is evidence that it belongs in the trusted finding stream.
