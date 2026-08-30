# Template repository conventions

## TEMPLATE-001 — Template repositories are executable golden paths

- Ship an intentional, working starting architecture and workflow rather than an empty scaffold.

## TEMPLATE-002 — Templates must dogfood the conventions they prescribe

- Maintain templates using the same conventions and workflow they require downstream.

## TEMPLATE-003 — Fresh instantiation is the acceptance test

- Validate a fresh instance, not only the template repository.

## TEMPLATE-004 — A template should have one canonical path to green

- Provide one repository-owned path from declared prerequisites to a known-green state.

## TEMPLATE-005 — Only propagate intentional decisions

- Everything included in a template is an endorsed downstream default.

## TEMPLATE-006 — Prove the stack with a thin vertical slice

- Prefer the smallest coherent end-to-end example over disconnected demos or placeholders.

## TEMPLATE-007 — Downstream friction feeds back into the template

- Promote repeated downstream fixes and workarounds into the template when they reveal a baseline gap.

## TEMPLATE-008 — Templates declare their applicable convention stack

- Reference applicable convention IDs and technology scopes from machine-readable local configuration or profiles.
