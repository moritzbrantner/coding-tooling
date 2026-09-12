import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import {
  prepareTestCaseEvidenceRun,
  readTestCaseEvidence,
} from "../src/test-case-evidence.ts";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(`${tmpdir()}/coding-tooling-case-evidence-`);
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("test case evidence protocol", () => {
  test("accepts only the exact invocation identity and preserves case outcomes", () => {
    const repository = root();
    const prepared = prepareTestCaseEvidenceRun(
      repository,
      "revision-a",
      "test:integration",
      "fixture",
    );
    writeFileSync(
      prepared.absolutePath,
      JSON.stringify({
        schemaVersion: 1,
        runId: prepared.runId,
        revision: prepared.revision,
        capability: prepared.capability,
        component: prepared.component,
        cases: [
          { id: "success", outcome: "passed" },
          { id: "deferred", outcome: "todo" },
        ],
      }),
    );

    const result = readTestCaseEvidence(prepared);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available evidence");
    expect(result.cases.get("success")).toBe("passed");
    expect(result.cases.get("deferred")).toBe("todo");
  });

  test("rejects stale revision evidence", () => {
    const repository = root();
    const prepared = prepareTestCaseEvidenceRun(
      repository,
      "revision-a",
      "test:integration",
      "fixture",
    );
    writeFileSync(
      prepared.absolutePath,
      JSON.stringify({
        schemaVersion: 1,
        runId: prepared.runId,
        revision: "revision-before-this-run",
        capability: prepared.capability,
        component: prepared.component,
        cases: [],
      }),
    );

    expect(readTestCaseEvidence(prepared)).toEqual({
      status: "invalid",
      reason: "test-case-evidence-revision-mismatch",
    });
  });

  test("rejects an artifact from another invocation even at the same revision", () => {
    const repository = root();
    const prepared = prepareTestCaseEvidenceRun(
      repository,
      "revision-a",
      "test:integration",
      "fixture",
    );
    writeFileSync(
      prepared.absolutePath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "another-run",
        revision: prepared.revision,
        capability: prepared.capability,
        component: prepared.component,
        cases: [],
      }),
    );

    expect(readTestCaseEvidence(prepared)).toEqual({
      status: "invalid",
      reason: "test-case-evidence-run-id-mismatch",
    });
  });

  test("rejects duplicate case ids instead of choosing one outcome", () => {
    const repository = root();
    const prepared = prepareTestCaseEvidenceRun(
      repository,
      "revision-a",
      "test:integration",
      "fixture",
    );
    writeFileSync(
      prepared.absolutePath,
      JSON.stringify({
        schemaVersion: 1,
        runId: prepared.runId,
        revision: prepared.revision,
        capability: prepared.capability,
        component: prepared.component,
        cases: [
          { id: "same-case", outcome: "passed" },
          { id: "same-case", outcome: "failed" },
        ],
      }),
    );

    expect(readTestCaseEvidence(prepared)).toEqual({
      status: "invalid",
      reason: "test-case-evidence-duplicate-case:same-case",
    });
  });

  test("keeps a missing artifact distinguishable from invalid evidence", () => {
    const repository = root();
    const prepared = prepareTestCaseEvidenceRun(
      repository,
      "revision-a",
      "test:integration",
      "fixture",
    );

    expect(readTestCaseEvidence(prepared)).toEqual({
      status: "missing",
      reason: "test-case-evidence-artifact-not-produced",
    });
  });
});
