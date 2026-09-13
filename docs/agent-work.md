# Agent work evidence

`coding-tooling` provides deterministic, ephemeral evidence for coding-agent work. It does not own durable queues, scheduling, conversation history, or orchestration state.

## Task packet

A task packet records the bounded capability being changed and the constraints that must survive the change.

```json
{
  "schemaVersion": "coding-tooling/task-packet/v1",
  "goal": "Make checkpoint recovery reject missing intermediate mesh deltas",
  "baselineSha": "0123456789abcdef0123456789abcdef01234567",
  "ownedCapability": "streaming/checkpoint-recovery",
  "mustPreserve": [
    "exact geometry fingerprints",
    "checkpoint byte stability"
  ],
  "outOfScope": [
    "transport protocol redesign"
  ],
  "changeKinds": ["behavior", "protocol"],
  "acceptance": {
    "requiredCapabilities": ["test:integration"],
    "evidence": ["missing intermediate delta is rejected"]
  },
  "integrationCondition": "all exact-head required evidence passes"
}
```

Validate it with:

```sh
coding-tooling agent task-packet .artifacts/coding-tooling/task.json --json
```

Task packets should normally live under an ignored `.artifacts/` path. They are execution evidence, not a second project backlog.

## Change classification

`changeKinds` derives risk-appropriate evidence instead of making each agent invent a validation plan. The current mapping distinguishes behavior, refactoring, performance, protocol, persistence, browser, mobile, dependency, security, deterministic replay, and documentation changes. Explicit acceptance capabilities and evidence are additive.

A missing required capability is unavailable evidence, not a passing result.

## Exact-head verification

```sh
coding-tooling agent verify .artifacts/coding-tooling/task.json \
  --report .artifacts/coding-tooling/verification.json \
  --json
```

Verification requires a clean worktree, captures the exact candidate SHA, executes the task packet's derived capabilities through the repository's canonical capability interface, verifies that HEAD did not move, and refuses a verifier that changes tracked state. It also records the repository's expected environment identity.

## Handoff receipt

```sh
coding-tooling agent handoff .artifacts/coding-tooling/task.json \
  --verification-report .artifacts/coding-tooling/verification.json \
  --report .artifacts/coding-tooling/handoff.json \
  --json
```

A handoff is valid only when the verification report passed for the current candidate SHA and the exact task-packet digest. The receipt records baseline and candidate identity, changed files, environment evidence, unresolved deterministic findings, and the strongest next action.

This makes continuation cheap: a later agent can verify the receipt rather than reconstructing the previous run from prose.

## PR integration receipt

```sh
coding-tooling pr receipt 42 \
  --expected-head 0123456789abcdef0123456789abcdef01234567 \
  --expected-base fedcba9876543210fedcba9876543210fedcba98 \
  --json
```

The receipt composes the existing fail-closed PR eligibility collector and explicitly classifies attached checks as passed, skipped, pending, failed, or unavailable. A required skipped check is not green. Draft state, mergeability, review state, unresolved review threads, stack dependencies, policy-sensitive changes, and available performance checks remain visible in one exact-candidate envelope.

The receipt does not replace semantic review. It makes the mechanical integration boundary deterministic so the remaining review can concentrate on authority, behavior, and evidence claims.

## Next slice

```sh
coding-tooling next --json
```

Selection is deterministic and non-mutating. It chooses one candidate in this order:

1. open PRs needing reconciliation;
2. open PRs needing refresh;
3. clean open PRs ready for review/integration;
4. unchecked roadmap items;
5. open issues;
6. actionable `TODO:` markers;
7. remaining deterministic capability gaps.

The full ranked evidence is returned alongside the one selected slice. A reasoning skill may turn that selected candidate into a task packet, but it must not silently substitute a different project direction.
