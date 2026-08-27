---
id: "general/code-review"
name: "code-review"
description: "Run standards review and, when applicable, specification review as separate read-only axes."
kind: "flow"
maturity: "stable"
entry-point: true
intents: ["review", "quality", "acceptance"]
requires: []
related-to: ["general/standards-review", "general/spec-review", "general/review-and-fix"]
readiness: []
flow:
  steps:
    - id: review-axes
      kind: parallel
      steps:
        - id: standards
          kind: invoke
          capability: "general/standards-review"
          output: "standards-findings"
        - id: spec-if-applicable
          kind: branch
          condition:
            source: "review-context.has-spec-or-ticket"
            equals: true
          then:
            - id: spec
              kind: invoke
              capability: "general/spec-review"
              output: "spec-findings"
          else: []
extensions: {}
---
# Validation fixture
