# HTTP behavioral case evidence

A passing integration or end-to-end capability does not prove that every HTTP operation mapped to that capability was tested.

For HTTP public-contract surfaces, coding-tooling therefore separates the broad capability outcome from exact behavioral case evidence.

## Manifest declaration

A strong HTTP verification can declare a case:

```json
{
  "id": "create-post-success",
  "surface": "http-operation:POST:%2Fposts",
  "kind": "behavioral",
  "capability": "test:integration",
  "case": {
    "id": "posts-create-success",
    "behavior": "success"
  }
}
```

The supported behavior dimensions in schema version 1 are:

- `availability`
- `validation`
- `authorization`
- `success`
- `persistence`
- `not-found`
- `idempotency`
- `cancellation`
- `concurrency`

These labels describe repository-owned behavioral intent. Coding-tooling does not infer whether a particular endpoint should return a specific status code or implement a particular authorization policy.

## Exact-run protocol

When an HTTP verification declares a case, coding-tooling allocates a unique evidence artifact path and run id for that capability invocation. It exposes them to the test process as:

- `CODING_TOOLING_CASE_EVIDENCE_PATH`
- `CODING_TOOLING_CASE_EVIDENCE_RUN_ID`
- `CODING_TOOLING_CASE_EVIDENCE_REVISION`
- `CODING_TOOLING_CASE_EVIDENCE_CAPABILITY`
- `CODING_TOOLING_CASE_EVIDENCE_COMPONENT`

A runner adapter or repository test harness writes schema version 1 JSON to the requested path:

```json
{
  "schemaVersion": 1,
  "runId": "<exact supplied run id>",
  "revision": "<exact supplied revision>",
  "capability": "test:integration",
  "component": ".",
  "cases": [{ "id": "posts-create-success", "outcome": "passed" }]
}
```

Accepted outcomes are `passed`, `failed`, `skipped`, and `todo`.

The artifact is accepted only when run id, revision, capability, and component all match the current invocation. Duplicate case ids make the artifact invalid. This prevents committed or stale evidence from being reused as current verification.

## Verification semantics

For an HTTP operation with strong evidence:

- the broad capability must pass;
- the verification must declare an exact case;
- the exact case must be present in the current invocation artifact;
- the exact case outcome must be `passed`.

A skipped or TODO case remains unavailable evidence. A missing case remains unavailable. Invalid exact-run evidence is an error. A missing case declaration is reported as `public-contract-http-case-evidence-missing`.

The report preserves `capabilityOutcome` separately from the effective verification `outcome`, so a user can see that a suite passed while a particular operation remains unverified.

Non-HTTP public-contract surfaces retain their existing broad capability semantics in this slice.

## Evidence boundary

This protocol proves that the repository's current test invocation reported a named behavioral case as passed. It does not independently prove assertion quality, function or branch coverage, or mutation resistance. Those are separate evidence layers and must not be collapsed into the case result.
