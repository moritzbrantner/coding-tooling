---
id: "general/to-tickets"
name: "to-tickets"
description: "Decompose an approved spec into individual traceable Markdown ticket artifacts and a dependency graph."
kind: "skill"
maturity: "stable"
entry-point: true
intents: ["tickets", "decompose", "planning"]
requires: []
related-to: ["general/to-spec", "general/reconcile-tickets"]
readiness:
  - predicate: "artifact-available"
    artifact: "canonical-spec"
  - predicate: "tool-available"
    tool: "coding-tooling"
extensions: {}
---
# Validation fixture
