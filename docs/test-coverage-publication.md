# Test coverage publication protocol

`coding-tooling` separates **coverage generation** from **coverage observation**. Test runners remain repository-native; CI publishes a small normalized snapshot that public consumers can read without cloning the repository or committing generated coverage trees to the default branch.

## Publication location

Public repositories publish schema version 1 to the dedicated branch and path:

```text
branch: coding-tooling-observations
path:   .coding-tooling/test-coverage.json
```

The observation branch is generated evidence. It is not source code, does not participate in the normal development history, and should only be written by deterministic CI running against the repository default branch.

## Snapshot schema

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

## Producer contract

A publisher must:

1. run the repository's existing tests with a native coverage reporter;
2. normalize only measurements actually present in that report;
3. stamp the exact default-branch Git revision and generation timestamp;
4. publish the snapshot to `coding-tooling-observations` only after successful test execution;
5. never convert missing coverage evidence into `0%`;
6. never make publication itself a coverage threshold or enforcement gate.

The native producer may be Bun/Vitest/Istanbul, Cargo tooling, xUnit tooling, or another deterministic test stack. The publication schema, not the underlying framework, is the cross-repository contract.

## Consumer contract

`/test-coverage.json/?repo=owner/repository` checks the standardized published snapshot first. If it exists, the observer validates repository provenance and compares its revision with the current default-branch head, reporting freshness as `current` or `stale`.

For compatibility with repositories that have not adopted publication yet, the observer falls back to recognized LCOV or Istanbul reports committed on the default branch. If neither source exists, it returns `unavailable`; malformed evidence returns `incomplete`.

## Dogfood

`coding-tooling` publishes its own coverage from `.github/workflows/coverage.yml`. Bun produces `coverage/lcov.info`, `scripts/build-test-coverage-snapshot.js` normalizes it, and CI updates only the observation branch. This is the reference implementation for the protocol before wider repository rollout.
