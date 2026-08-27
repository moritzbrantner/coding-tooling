---
id: "general/optimize-performance"
name: "optimize-performance"
description: "Measure a performance bottleneck, apply a behavior-preserving optimization, verify correctness, remeasure, and review."
kind: "flow"
maturity: "stable"
entry-point: true
intents: ["performance", "optimize", "profile"]
requires: []
related-to: ["general/diagnosing-performance", "general/refactor", "general/code-review"]
readiness:
  - predicate: "action-available"
    action: "repository.verify"
flow:
  steps:
    - id: baseline-diagnosis
      kind: invoke
      capability: "general/diagnosing-performance"
      output: "baseline"
    - id: actionable
      kind: branch
      condition:
        source: "baseline.actionable"
        equals: true
      then:
        - id: optimize
          kind: invoke
          capability: "general/refactor"
          inputs:
            performance-diagnosis: "baseline"
          output: "optimized-change"
      else:
        - id: insufficient-evidence
          kind: human-gate
          prompt: "The measured evidence does not justify a specific optimization. Decide whether to change constraints or stop."
    - id: verify
      kind: action
      action: "repository.verify"
    - id: remeasure
      kind: invoke
      capability: "general/diagnosing-performance"
      output: "after"
    - id: review
      kind: invoke
      capability: "general/code-review"
      output: "review-findings"
extensions: {}
---
# Validation fixture
