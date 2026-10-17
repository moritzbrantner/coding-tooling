# Controlled performance measurements on a dedicated runner

Status: **owner-approved 2026-10-15 (choice B)**; ~~infrastructure, security authorization and measured acceptance **pending**.~~ simplified 2026-10-17: ship active on one pilot repository without a security/verification gate. Implementation: [#158](https://github.com/moritzbrantner/coding-tooling/issues/158). Consumer latency/deadline contracts: [#302](https://github.com/moritzbrantner/coding-tooling/issues/302).

## Decision

Use an **owner-provisioned, fixed/dedicated self-hosted benchmark runner** as the source of **comparable wall-clock performance history**. This is preferred over a CodSpeed service/account/token integration for the initial controlled-history rollout. The ordinary GitHub-hosted/shared runners are still permitted for correctness and advisory timing, **not** authoritative historical regression or latency-budget verdicts.

This choice selects the evidence _source_, not a runner that already exists. No specific processor, operating system, physical/virtual setup, capacity, repository access or trigger policy is approved by this choice. ~~The owner must provision the controlled host and approve its security/trust boundary before the implementation relies on it.~~ The runner label is per-repository configuration; no approval gate precedes use.

## Boundaries and acceptance

- The repository under test owns representative operations, fixtures, input/revision identities, timing ceilings and sample policy. **Runtime Profiler** (or the existing repository-declared native collector) owns measurement capture. Coding Tooling owns discovery, invocation, identity checks, comparability and explicit result classification. Do not create another profiler or profiler-side scheduler.
- Record the actual CPU/machine class, OS/kernel, toolchain/runtime, workload/fixture revisions, process isolation/load, timing mode, cold/warm conditions, repetition/sample count, collector version and environment/config fingerprints with each result. Compare history **only when the required identity and environmental equivalence are established**. A hash of declarations alone is not evidence that machines or measurements are equivalent.
- Missing runner, unavailable capability, changing hardware/OS/workload, noisy/insufficient samples or unverified collector yields **unavailable/incomparable**, never a passing time budget. Preserve unchanged deterministic work-complexity checks and ordinary smoke benchmarks; existing noisy shared-runner time deltas remain informational.
- ~~Security gate before connecting a public repository to any self-hosted runner: define and approve trusted execution triggers and repository/workflow access, explicitly exclude untrusted pull-request/fork code, run jobs in isolated disposable environments with minimal permissions, do not expose secrets or internal systems, and establish runner update, logging, cleanup and compromise-recovery procedures. A dedicated hardware host **must not** become a general-purpose public-PR runner. GitHub's [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) warns against self-hosted runners for public repositories; its [runner documentation](https://docs.github.com/en/actions/reference/runners/self-hosted-runners) recommends ephemeral job runners. Owner authorization of this trust model and actual isolation remains pending.~~ Superseded 2026-10-17: no security-approval gate, attestation, trusted-event allowlist or fingerprint matching is required (see owner decisions below).
- Deliver a single real repository-owned benchmark on the approved controlled runner, plus the same workload under an intentionally noncomparable environment to prove the comparison refuses it. Capture exact commands, artifacts, provenance, history and failure/unavailable handling before claiming controlled-history availability. Do not impose historical ratchets as extra unconditional PR gates; explicit operation latency contracts under #302 may block only with valid, controlled evidence.

## Consequences

This avoids a required external benchmarking account/secret but adds owner-owned hardware, setup, security and maintenance obligations. The runner decision **unblocks planning** of #158's comparison contract; it does **not** unblock strict wall-clock pass claims or authorize provisioning/security assumptions. Until real, approved controlled hardware is operational, leave that evidence unavailable and continue work on independent deterministic checks.

## Owner decisions — comparison boundary and history storage (2026-10-17)

- **Comparability (A):** coding-tooling delegates measurement comparison to `runtime-profiler score` (its strict bundle comparability). coding-tooling adds only runner attestation, trusted-trigger provenance, the sample/noise policy declared in `.performance/contract.json`, and the final `comparable | incomparable | unavailable` classification. It does not maintain a second comparator over raw bundle facts.
- **History persistence (A):** controlled history is stored on a data-only orphan branch following the [`score-history`](../score-history.md) pattern, written only by the trusted controlled-runner workflow.

Recorded from [#158](https://github.com/moritzbrantner/coding-tooling/issues/158).

## Owner decisions — minimal, active rollout (2026-10-17)

These replace any contrary text above. Owner: _"I don't want a workflow to spend any time on trying to verify some fingerprints or match them against something"_; _"we start per repo, I want to see that thing tested before"_.

- **No attestation or verification ceremony:** no runner attestation, trusted-event allowlist, fingerprint matching or security-approval gate in coding-tooling or the workflow. History entries may record plain runner/run metadata for information only. Like-for-like comparison is whatever `runtime-profiler score` itself refuses or accepts.
- **Per repository first:** the runner and controlled policy are declared in the repository's own configuration; no fleet-wide profile until it has proven itself in one repository.
- **Policy location:** an optional `controlled` block in `.performance/contract.json`; contract schema v2 unchanged.
- **Scope:** ship it active — comparison via `runtime-profiler score`, orphan-branch history and a workflow enabled on one pilot repository (runtime-profiler's `example-command` scenario unless something simpler exists). No inactive template.

Implemented as the optional `controlled.history` contract block and `coding-tooling performance history`; see [controlled performance history](../performance-history.md).

## Owner decisions — latency/deadline acceptance (#302, 2026-10-17)

- Declare an optional `latency` block on an existing v2 `operation` in `.performance/contract.json`; schema version unchanged.
- Timing comes from the latest runtime-profiler bundle/score for the bound scenario; coding-tooling reads the recorded statistic and does not judge the environment.
- A declared `maxMs` miss fails `latency_deadline` everywhere, including GitHub-hosted runs. Historical ratchets stay informational unless a repository opts in.
- First slice: the `latency_deadline` verdict plus the combined five-verdict report (`functional`, `work_growth`, `absolute_work`, `latency_deadline`, `historical_ratchet`); frame pacing waits for a real fixture.
- Pilot: runtime-profiler `runtime-profiler-history-self-score-v1`, with `maxMs` derived from current history (e.g. current p95 × 1.5, rounded) and stated on #302.

