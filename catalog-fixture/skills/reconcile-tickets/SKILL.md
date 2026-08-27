---
id: "general/reconcile-tickets"
name: "reconcile-tickets"
description: "Reconcile stale spec-bound ticket artifacts through deterministic diff evidence and explicit human decisions."
kind: "skill"
maturity: "stable"
entry-point: true
intents: ["tickets", "reconcile", "spec-change"]
requires: ["general/grilling"]
related-to: ["general/to-tickets", "general/grilling"]
readiness:
  - predicate: "artifact-available"
    artifact: "spec-and-ticket-set"
  - predicate: "tool-available"
    tool: "coding-tooling"
extensions: {}
---
# Validation fixture
