# AGENT-010 — Apply progressive composition to agent execution

**Status:** Accepted
**Category:** Agents
**Derived from:** `PRINCIPLE-006`

## Rule

Use `PRINCIPLE-006 — Escalate complexity only when the workload requires it` as the single normative source when choosing between direct agent work, reusable skills, iterative loops, work items, and orchestration.

This convention introduces no additional execution-layer policy. Its purpose is to give agent-focused documents and tooling a stable convention identifier that points to the repository-level principle without duplicating it.

## Agent behavior

When an agent-facing procedure needs to decide whether a higher execution layer is warranted, follow `PRINCIPLE-006` directly.

## Automatable check

Agent documentation may reference `AGENT-010` as the agent-category pointer, but checks should resolve the normative rule to `PRINCIPLE-006` rather than maintaining a second copy of the escalation criteria.
