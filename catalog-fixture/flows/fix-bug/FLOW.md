---
id: "general/fix-bug"
name: "fix-bug"
description: "Diagnose a bug, resolve uncertain intent when necessary, own the regression red-to-green fix, then refactor, verify, and review."
kind: "flow"
maturity: "stable"
entry-point: true
intents: ["bug", "fix", "regression"]
requires: []
related-to: ["general/diagnosing-bugs", "general/tdd", "general/refactor"]
readiness:
  - predicate: "action-available"
    action: "repository.verify"
flow:
  steps:
    - id: diagnose
      kind: invoke
      capability: "general/diagnosing-bugs"
      output: "diagnosis"
    - id: uncertain-diagnosis
      kind: branch
      condition:
        source: "diagnosis.confidence"
        equals: "uncertain"
      then:
        - id: confirm-intent
          kind: human-gate
          prompt: "Resolve the remaining intended-behavior or diagnosis ambiguity before changing behavior."
      else: []
    - id: red-green-fix
      kind: invoke
      capability: "general/tdd"
      inputs:
        diagnosis: "diagnosis"
      output: "green-fix"
    - id: cleanup
      kind: invoke
      capability: "general/refactor"
      inputs:
        baseline: "green-fix"
      output: "refactor-result"
    - id: verify
      kind: action
      action: "repository.verify"
    - id: review
      kind: invoke
      capability: "general/code-review"
      output: "review-findings"
extensions: {}
---
# Validation fixture
