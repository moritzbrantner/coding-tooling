---
id: "general/spec-review"
name: "spec-review"
description: "Review a candidate against its applicable ticket and exact parent specification revision without modifying it."
kind: "skill"
maturity: "stable"
entry-point: true
intents: ["review", "spec", "acceptance"]
requires: []
related-to: ["general/code-review", "general/to-spec", "general/to-tickets"]
readiness:
  - predicate: "artifact-available"
    artifact: "applicable-spec-or-ticket"
extensions: {}
---
# Validation fixture
