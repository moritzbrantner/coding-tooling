# Principles

## PRINCIPLE-001 — Prefer determinism over inference

- Prefer executable checks, deterministic mappings, explicit baselines, and structured ownership over semantic inference.

## PRINCIPLE-002 — Structure should encode agent-relevant information

- Use paths, hierarchy, names, and local instructions to communicate scope, ownership, relevance, and dependencies.

## PRINCIPLE-003 — Validate progressively

- Run the narrowest, cheapest affected checks first; expand only after they pass.
- Re-run invalidated lower layers after a production-code change.

## PRINCIPLE-004 — Make completion observable

- Completion is defined by repository-owned, independently repeatable gates—not agent confidence.

## PRINCIPLE-005 — Document decisions, not defaults

- Document consequential choices agents cannot reliably infer.
- Prefer tooling over prose for deterministic behavior.

## PRINCIPLE-006 — Escalate complexity only when the workload requires it

- Treat direct human-to-agent work as a first-class execution mode.
- Add reusable skills when a procedure should be shared; add a loop when iteration should be automated; add tasks or orchestration only when coordination, dependency management, concurrency, durable control state, or multi-worker ownership justify them.
- Higher-level execution layers may compose lower-level capabilities, but lower-level capabilities must not require higher-level machinery merely because it exists.
- Prefer escalation from a simple invocation over configuration that makes a large framework tolerate simple work.
