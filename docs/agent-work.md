# Agent work evidence

`coding-tooling` provides deterministic, ephemeral evidence for coding-agent work. It does not own durable queues, scheduling, conversation history, or orchestration state.

## Agent summary

Start with the compact consumption surface when an agent needs to decide what the repository evidence currently says:

```sh
coding-tooling agent summary --json
```

The summary is a read-only projection over existing findings and remediation evidence. It does not add another oracle or confidence score. It records the current Git candidate SHA, whether the worktree is clean, a repository decision (`clean`, `partial`, or `blocked`), the strongest evidence group, and the strongest existing remediation candidate.

Findings are collapsed only when they describe the same subject and share the same evidence `independenceKey`. Correlated representations therefore do not look like independent confirmations, while distinct files, packages, or repository subjects remain separate actionable observations.

The summary keeps the full audit surfaces available through explicit drill-down commands:

```sh
coding-tooling finding <finding-id> --json
coding-tooling findings --json
coding-tooling remediation plan --json
```

Use those larger envelopes when the compact projection is insufficient. The summary should be the normal first read for an agent; the audit surfaces remain authoritative for the underlying details.

## Task packet

A task packet records the bounded capability being changed and the constraints that must survive the change.

```json
{
  "schemaVersion": "coding-tooling/task-packet/v1",
  "goal": "Make checkpoint recovery reject missing intermediate mesh deltas",
  "baselineSha": "0123456789abcdef0123456789abcdef01234567",
  "ownedCapability": "streaming/checkpoint-recovery",
  "mustPreserve": ["exact geometry fingerprints", "checkpoint byte stability"],
  "outOfScope": ["transport protocol redesign"],
  "changeKinds": ["behavior", "protocol"],
  "acceptance": {
    "requiredCapabilities": ["test:integration"],
    "reviewRequirements": ["missing intermediate delta is rejected"]
  },
  "integrationCondition": "all exact-head required evidence passes"
}
```

Validate it with:

```sh
coding-tooling agent task-packet .artifacts/coding-tooling/task.json --json
```

Task packets should normally live under an ignored `.artifacts/` path. They are execution evidence, not a second project backlog.

Use a task packet when work is delegated or resumable, crosses a repository/protocol boundary, or has preservation constraints that a later run must verify exactly. A small local mechanical repair does not need a task packet merely to satisfy ceremony; the ordinary findings, summary, and canonical validation path remain sufficient.

## Change classification

`changeKinds` derives risk-appropriate evidence instead of making each agent invent a validation plan. The current mapping distinguishes behavior, refactoring, performance, protocol, persistence, browser, mobile, dependency, security, deterministic replay, and documentation changes. Explicit acceptance capabilities and semantic review requirements are additive.

A missing required capability is unavailable evidence, not a passing result. Semantic review requirements are carried into handoff/integration review and are never presented as machine-verified evidence.

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

## Repository-owned product acceptance and merge verification

Opt in only for behavioral or architectural work that has a repository-approved
specification and an independently supplied acceptance contract. Existing v1
packets without `acceptance.product` retain their current validation behavior
and report `mergeVerification.mode: "full-required"` rather than inventing an
affected-test dependency proof.

`acceptance.product` adds three required fields:

- `specifications`: repository-relative `{path, revision}` pointers to the
  approved product description or ADR. Each `revision` is the full Git
  commit SHA whose file content was approved.
- `contracts`: repository-relative `{path, revision, capability}` pointers
  to acceptance tests, with a canonical test capability responsible for
  executing each contract. A test revision can be the earlier tests-first
  acceptance commit. Git ancestry and unchanged blob identity are checked at
  the current candidate SHA.
- `coreSmokeCapabilities`: non-empty test capabilities that the repository
  requires on every verification, irrespective of affected-test selection.

Optionally, `independentAgentClaim` names the separate authoring context.
This is **an unverified claim**, never proof of agent separation. The report
preserves `machineVerified: false`; reviewers must validate that handoff
procedurally. Neither a particular commit author nor an older timestamp is
mechanical evidence of independence.

See `fixtures/agent-product-acceptance.json` for an illustrative v1 packet;
replace all fixture SHA and paths with actual committed repository-owned
revisions before use.

`agent task-packet` validates and normalizes these optional fields into its
stable digest. `agent verify` requires a clean candidate checkout, validates
every referenced path against repository containment (including symlink
escapes), regular-file type, Git ancestry and unchanged content at HEAD, and
runs the existing capability checks. Missing, deleted, modified, or
non-ancestor references are unavailable evidence, not stale success.

### `data.mergeVerification` in verification and handoff

`mode` is `affected` or `full-required`. The object includes a stable
`reason`, `sourceRevision`, `selectedTests`,
`coreSmokeCapabilities`, `coverageBasis`, and `execution`.

`affected` is allowed only when native Bun/Vitest discovery completely
enumerates every conventional test in the selected `test` capability,
without exclusions or truncation, every test has a closed static relative
import graph, every changed source module is reachable from a discovered
test, and all referenced acceptance tests are included. Unknown imports,
runtime/dynamic resolution, cross-component or configuration changes,
deleted paths, untested source, incomplete native discovery, unsupported
runners, or the 50-file discovery display cap require `full-required`.
Repository filenames, ranked candidate tests, and risk scores never prove
coverage. This is structural dependency evidence, not a semantic proof that
assertions sufficiently test behavior.

The verifier currently **executes the full canonical capability commands**
even when its minimum selection is `affected`; the report states
`execution: "full-capability-checks"`, not that only selected test files
ran. Under `full-required`, it includes all discovered test capabilities
in addition to task, smoke, and contract capabilities. New test files and
pinned acceptance contracts require available native execution-discovery
evidence in passed capability results; otherwise verification is
`unavailable`. Existing build, integration and review requirements remain
in force. `agent handoff` passes along the decision only for an exact-head,
passed verification with the matching task digest, and never marks
independent authoring or semantic review as mechanically resolved.
