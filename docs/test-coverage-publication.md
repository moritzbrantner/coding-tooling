# Test coverage publication protocol

`coding-tooling` separates **coverage generation** from **coverage observation**. Test runners remain repository-native; CI publishes normalized evidence that public consumers can read without cloning the repository or committing generated coverage trees to the default branch.

## Publication location

Public repositories publish summary schema version 1 to the dedicated branch and path:

```text
branch: coding-tooling-observations
path:   .coding-tooling/test-coverage.json
```

The observation branch is generated evidence. It is not source code, does not participate in the normal development history, and should only be written by deterministic CI running against the repository default branch.

## Summary snapshot schema

```json
{
  "schemaVersion": 1,
  "kind": "coding-tooling-test-coverage-snapshot",
  "repository": {
    "fullName": "owner/repository",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "generatedAt": "2026-09-03T13:30:00.000Z",
  "producer": {
    "id": "coding-tooling",
    "protocolVersion": 1
  },
  "source": {
    "path": "coverage/lcov.info",
    "format": "lcov"
  },
  "coverage": {
    "lines": { "covered": 90, "total": 100, "percent": 90 },
    "statements": null,
    "functions": { "covered": 18, "total": 20, "percent": 90 },
    "branches": { "covered": 14, "total": 20, "percent": 70 }
  }
}
```

A metric may be `null` when the native report format does not establish it. Schema v1 intentionally carries no threshold, grade, pass/fail state, or inferred quality judgment.

## Detailed coverage artifact

When the native report provides source-level detail, CI may additionally publish:

```text
branch: coding-tooling-observations
path:   .coding-tooling/test-coverage-detail.json
```

The first detail protocol is LCOV-only and preserves exact file, line, function, and branch observations:

```json
{
  "schemaVersion": 1,
  "kind": "coding-tooling-test-coverage-detail",
  "repository": {
    "fullName": "owner/repository",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "generatedAt": "2026-09-12T11:30:00.000Z",
  "producer": {
    "id": "coding-tooling",
    "protocolVersion": 1
  },
  "source": {
    "path": "coverage/lcov.info",
    "format": "lcov"
  },
  "granularity": "suite",
  "files": [
    {
      "path": "src/example.ts",
      "lines": [{ "line": 12, "hits": 1, "covered": true }],
      "functions": [{ "name": "handleRequest", "line": 10, "hits": 1, "covered": true }],
      "branches": [{ "line": 13, "block": "0", "branch": "1", "hits": 0, "covered": false }]
    }
  ]
}
```

This artifact is measured **suite-level** evidence. It does not claim which individual test exercised a function or branch, does not infer a public-operation-to-function call graph, and does not claim that execution implies a meaningful assertion. Per-test attribution requires native per-test evidence or isolated measurement and belongs to a later protocol slice.

The detail artifact is deliberately separate from the compact summary so consumers that only need repository-level coverage do not need to fetch or process a potentially larger file.

## Producer contract

A publisher must:

1. run the repository's existing tests with a native coverage reporter;
2. normalize only measurements actually present in that report;
3. stamp the exact default-branch Git revision and generation timestamp;
4. publish the snapshot to `coding-tooling-observations` only after successful test execution;
5. never convert missing coverage evidence into `0%`;
6. never make publication itself a coverage threshold or enforcement gate.

Detailed coverage publishers additionally preserve native source/function/branch identities without manufacturing per-test attribution or static call relationships.

The native producer may be Bun/Vitest/Istanbul, Cargo tooling, xUnit tooling, or another deterministic test stack. The publication schema, not the underlying framework, is the cross-repository contract. Detail schema version 1 starts with LCOV so the first implementation can prove one exact format rather than guessing across ecosystems.

## Consumer contract

`/test-coverage.json/?repo=owner/repository` checks the standardized published summary snapshot first. If it exists, the observer validates repository provenance and compares its revision with the current default-branch head, reporting freshness as `current` or `stale`.

For compatibility with repositories that have not adopted publication yet, the observer falls back to recognized LCOV or Istanbul reports committed on the default branch. If neither source exists, it returns `unavailable`; malformed evidence returns `incomplete`.

The detail artifact is a separate evidence surface for later operation/function/branch analysis. Summary consumers must not infer detail that was not loaded, and detail consumers must reject stale or mismatched repository revisions rather than joining incompatible evidence.

## Dogfood

`coding-tooling` publishes its own summary and detailed coverage from `.github/workflows/coverage.yml`. Bun produces `coverage/lcov.info`; the summary and detail builders normalize the same exact report and revision; CI updates only the observation branch. This is the reference implementation for the protocol before wider repository rollout.
