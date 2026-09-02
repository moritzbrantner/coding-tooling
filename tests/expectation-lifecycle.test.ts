import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeExpectations,
  findingCommand,
  scaffoldFinding,
  type Finding,
  type ReconciliationReport,
} from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(testScript: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-expectation-lifecycle-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: testScript } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
  return root;
}

function sourceTestFinding(root: string): Finding {
  const finding = analyzeExpectations(root).findings.find(
    (item) => item.expectationId === "typescript-source-test",
  );
  expect(finding).toBeDefined();
  return finding!;
}

describe("expectation lifecycle", () => {
  test("only offers Bun test scaffolding when Bun is the configured test runner", () => {
    const root = fixture("vitest run");
    const finding = sourceTestFinding(root);

    expect(finding.expectationVersion).toBe(1);
    expect(finding.policyKind).toBe("advisory");
    expect(finding.scaffold).toBeUndefined();
    expect(finding.verification).toEqual([["bun", "run", "test", "--", "tests/service.test.ts"]]);
  });

  test("delegates Bun test scaffolding through the shared generator mutation path", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);

    expect(finding.scaffold).toEqual(
      expect.objectContaining({ kind: "create-file", path: "tests/service.test.ts" }),
    );
    expect(finding.verification).toEqual([["bun", "test", "tests/service.test.ts"]]);

    const result = scaffoldFinding(root, finding.id);
    const generation = result.data.generation as { result?: string; created?: string[] };

    expect(result.status).toBe("passed");
    expect(generation.result).toBe("generated");
    expect(generation.created).toEqual(["tests/service.test.ts"]);
    expect(existsSync(join(root, "tests", "service.test.ts"))).toBeTrue();
    expect(analyzeExpectations(root).findings.some((item) => item.id === finding.id)).toBeFalse();
  });

  test("keeps suppressed findings auditable without exposing them by default", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);
    expect(findingCommand(root, finding.id).data.result).toBe("active");

    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          suppressions: [{ id: finding.id, reason: "covered through an external contract" }],
        },
        null,
        2,
      )}\n`,
    );

    expect(analyzeExpectations(root).findings.some((item) => item.id === finding.id)).toBeFalse();
    const all = analyzeExpectations(root, { includeSuppressed: true }).findings;
    expect(all).toContainEqual(
      expect.objectContaining({
        id: finding.id,
        disposition: "suppressed",
        suppressionReason: "covered through an external contract",
      }),
    );
    expect(findingCommand(root, finding.id).data.result).toBe("suppressed");
  });

  test("reports stale and duplicate persistent metadata", () => {
    const root = fixture("bun test");
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          baseline: ["CT-000000000000", "CT-000000000000"],
          suppressions: [
            { id: "CT-111111111111", reason: "legacy" },
            { id: "CT-111111111111", reason: "duplicate legacy" },
            { expectation: "unknown-expectation", reason: "old detector" },
          ],
          invariants: [
            { id: "INV-1", scope: ".", statement: "one" },
            { id: "INV-1", scope: ".", statement: "duplicate" },
          ],
          enforcement: { "unknown-expectation": "warning" },
        },
        null,
        2,
      )}\n`,
    );

    const reconciliation = analyzeExpectations(root, { includeSuppressed: true })
      .reconciliation as ReconciliationReport;

    expect(reconciliation.orphanedBaseline).toEqual(["CT-000000000000"]);
    expect(reconciliation.duplicateBaseline).toEqual(["CT-000000000000"]);
    expect(reconciliation.duplicateSuppressions).toEqual([1]);
    expect(reconciliation.duplicateInvariants).toEqual(["INV-1"]);
    expect(reconciliation.unknownExpectations).toEqual(["unknown-expectation"]);
    expect(reconciliation.staleSuppressions).toHaveLength(3);
  });

  test("returns an explicit absent state for a valid inactive finding id", () => {
    const root = fixture("bun test");
    const result = findingCommand(root, "CT-FFFFFFFFFFFF");

    expect(result.status).toBe("passed");
    expect(result.data.result).toBe("absent");
  });
});
