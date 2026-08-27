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
      else:
        - id: insufficient-evidence
          kind: human-gate
          prompt: "The measured evidence does not justify a specific optimization. Stop, or provide revised constraints/workload for one more diagnosis."
        - id: retry-decision
          kind: branch
          condition:
            source: "performance-decision.action"
            equals: "retry"
          then:
            - id: revised-diagnosis
              kind: invoke
              capability: "general/diagnosing-performance"
              output: "revised-baseline"
            - id: revised-actionable
              kind: branch
              condition:
                source: "revised-baseline.actionable"
                equals: true
              then:
                - id: revised-optimize
                  kind: invoke
                  capability: "general/refactor"
                  inputs:
                    performance-diagnosis: "revised-baseline"
                  output: "revised-optimized-change"
                - id: revised-verify
                  kind: action
                  action: "repository.verify"
                - id: revised-remeasure
                  kind: invoke
                  capability: "general/diagnosing-performance"
                  output: "revised-after"
                - id: revised-review
                  kind: invoke
                  capability: "general/code-review"
                  output: "revised-review-findings"
              else:
                - id: still-insufficient
                  kind: human-gate
                  prompt: "The second diagnosis is still not actionable. Stop without optimizing or take the problem back to a new outer investigation."
          else: []
extensions: {}
---
# Validation fixture
