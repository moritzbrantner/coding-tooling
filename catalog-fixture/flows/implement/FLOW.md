---
id: "general/implement"
name: "implement"
description: "Execute an approved bounded change through its testing strategy, refactor inspection, verification, review, bounded remediation, and optional commit."
kind: "flow"
maturity: "stable"
entry-point: true
intents: ["implement", "change", "feature"]
requires: []
related-to: ["general/tdd", "general/refactor", "general/code-review", "general/review-and-fix"]
readiness:
  - predicate: "action-available"
    action: "repository.verify"
flow:
  steps:
    - id: testing-path
      kind: branch
      condition:
        source: "testing-strategy.mode"
        equals: "tdd"
      then:
        - id: red-green
          kind: invoke
          capability: "general/tdd"
          output: "green-implementation"
      else: []
    - id: refactor-inspection
      kind: invoke
      capability: "general/refactor"
      inputs:
        baseline: "green-implementation-or-current-change"
      output: "refactor-result"
    - id: verify
      kind: action
      action: "repository.verify"
    - id: review
      kind: invoke
      capability: "general/code-review"
      output: "first-review"
    - id: remediate
      kind: branch
      condition:
        source: "first-review.blocking"
        equals: true
      then:
        - id: bounded-remediation
          kind: invoke
          capability: "general/review-and-fix"
          inputs:
            findings: "first-review"
          output: "remediation-result"
      else: []
    - id: commit
      kind: action
      action: "vcs.commit"
      optional: true
      fallback: "skip"
extensions: {}
---
# Validation fixture
