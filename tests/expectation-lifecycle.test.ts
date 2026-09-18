import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeExpectations,
  deferFinding,
  findingCommand,
  findingsCommand,
  resumeFinding,
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

function addVerifierScript(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          test: "bun test",
          "verify:service": "bun scripts/verify-service.ts",
        },
      },
      null,
      2,
    )}\n`,
  );
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

    expect(finding.expectationVersion).toBe(2);
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

  test("uses explicit repository verification as auditable evidence instead of suppression", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);
    addVerifierScript(root);
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          verifications: [
            {
              id: "VERIFY-SERVICE",
              version: 1,
              expectation: "typescript-source-test",
              subject: "src/service.ts",
              command: ["bun", "run", "verify:service"],
              reason: "repository-owned contract verifies the generated metadata",
            },
          ],
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
        disposition: "verified",
        verificationEvidence: {
          id: "VERIFY-SERVICE",
          version: 1,
          command: ["bun", "run", "verify:service"],
          reason: "repository-owned contract verifies the generated metadata",
        },
      }),
    );
    expect(findingCommand(root, finding.id).data.result).toBe("verified");
    expect(
      (findingsCommand(root, { includeSuppressed: true }).data.counts as Record<string, number>)
        .verified,
    ).toBe(1);
  });

  test("invalid verification commands cannot silence findings", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          verifications: [
            {
              id: "VERIFY-MISSING",
              version: 1,
              expectation: "typescript-source-test",
              subject: "src/service.ts",
              command: ["bun", "run", "verify:missing"],
              reason: "intended verifier",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const analysis = analyzeExpectations(root, { includeSuppressed: true });
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({ id: finding.id, disposition: "active" }),
    );
    expect(analysis.reconciliation.invalidVerifications).toEqual([
      {
        index: 0,
        id: "VERIFY-MISSING",
        reason: "package . does not expose scripts.verify:missing",
      },
    ]);
  });

  test("does not let verification metadata override an explicit suppression", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);
    addVerifierScript(root);
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          suppressions: [{ id: finding.id, reason: "deliberately ignored for now" }],
          verifications: [
            {
              id: "VERIFY-SERVICE",
              version: 1,
              expectation: "typescript-source-test",
              subject: "src/service.ts",
              command: ["bun", "run", "verify:service"],
              reason: "repository-owned contract verifies the generated metadata",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const analysis = analyzeExpectations(root, { includeSuppressed: true });
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({ id: finding.id, disposition: "suppressed" }),
    );
    expect(analysis.reconciliation.invalidVerifications).toEqual([
      {
        index: 0,
        id: "VERIFY-SERVICE",
        reason:
          "finding is also suppressed; remove suppression before declaring verification evidence",
      },
    ]);
  });

  test("reports verification metadata as stale after the underlying finding is resolved", () => {
    const root = fixture("bun test");
    addVerifierScript(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "service.test.ts"), 'test("service", () => {});\n');
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          verifications: [
            {
              id: "VERIFY-SERVICE",
              version: 1,
              expectation: "typescript-source-test",
              subject: "src/service.ts",
              command: ["bun", "run", "verify:service"],
              reason: "legacy explicit verifier",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const analysis = analyzeExpectations(root, { includeSuppressed: true });
    expect(
      analysis.findings.some((item) => item.expectationId === "typescript-source-test"),
    ).toBeFalse();
    expect(analysis.reconciliation.staleVerifications).toEqual([
      { index: 0, id: "VERIFY-SERVICE" },
    ]);
  });

  test("reports duplicate verification relationships deterministically", () => {
    const root = fixture("bun test");
    addVerifierScript(root);
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          verifications: [
            {
              id: "VERIFY-ONE",
              version: 1,
              expectation: "typescript-source-test",
              subject: "src/service.ts",
              command: ["bun", "run", "verify:service"],
              reason: "primary verifier",
            },
            {
              id: "VERIFY-TWO",
              version: 1,
              expectation: "typescript-source-test",
              subject: "src/service.ts",
              command: ["bun", "run", "verify:service"],
              reason: "duplicate verifier",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    expect(
      analyzeExpectations(root, { includeSuppressed: true }).reconciliation.duplicateVerifications,
    ).toEqual([1]);
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
    expect(reconciliation.duplicateVerifications).toEqual([]);
    expect(reconciliation.duplicateInvariants).toEqual(["INV-1"]);
    expect(reconciliation.unknownExpectations).toEqual(["unknown-expectation"]);
    expect(reconciliation.staleSuppressions).toHaveLength(3);
    expect(reconciliation.staleVerifications).toEqual([]);
    expect(reconciliation.invalidVerifications).toEqual([]);
  });

  test("records a deferral without silencing the active finding", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);

    const deferred = deferFinding(root, finding.id, "covered by a broader composition test for now");

    expect(deferred.status).toBe("passed");
    const active = analyzeExpectations(root).findings.find((item) => item.id === finding.id);
    expect(active).toMatchObject({
      id: finding.id,
      disposition: "active",
      deferralEvidence: {
        version: 1,
        reason: "covered by a broader composition test for now",
      },
    });
    expect((findingsCommand(root).data.counts as Record<string, number>).deferred).toBe(1);

    const scaffold = scaffoldFinding(root, finding.id);
    expect(scaffold.status).toBe("unavailable");
    expect(scaffold.diagnostics[0]?.code).toBe("finding-deferred");

    expect(resumeFinding(root, finding.id).status).toBe("passed");
    expect(
      analyzeExpectations(root).findings.find((item) => item.id === finding.id)?.deferralEvidence,
    ).toBeUndefined();
  });

  test("reconciles stale, duplicate, and conflicting deferrals", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          suppressions: [{ id: finding.id, reason: "intentionally not required" }],
          deferrals: [
            { id: finding.id, version: 1, reason: "defer once" },
            { id: finding.id, version: 1, reason: "duplicate deferral" },
            { id: "CT-111111111111", version: 1, reason: "stale work item" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const reconciliation = analyzeExpectations(root, { includeSuppressed: true }).reconciliation;
    expect(reconciliation.duplicateDeferrals).toEqual([1]);
    expect(reconciliation.staleDeferrals).toEqual([{ index: 2, id: "CT-111111111111" }]);
    expect(reconciliation.conflictingDeferrals).toEqual([
      {
        index: 0,
        id: finding.id,
        reason: "finding is suppressed; only active findings can be deferred",
      },
    ]);
  });

  test("reports a deferral as stale after the underlying finding is resolved", () => {
    const root = fixture("bun test");
    const finding = sourceTestFinding(root);
    expect(deferFinding(root, finding.id, "revisit after adjacent work").status).toBe("passed");

    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "service.test.ts"),
      'import { service } from "../src/service.ts";\nvoid service;\n',
    );

    expect(analyzeExpectations(root, { includeSuppressed: true }).reconciliation.staleDeferrals).toEqual([
      { index: 0, id: finding.id },
    ]);
  });

  test("returns an explicit absent state for a valid inactive finding id", () => {
    const root = fixture("bun test");
    const result = findingCommand(root, "CT-FFFFFFFFFFFF");

    expect(result.status).toBe("passed");
    expect(result.data.result).toBe("absent");
  });
});
