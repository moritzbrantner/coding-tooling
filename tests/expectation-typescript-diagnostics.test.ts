import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations, findingsCommand } from "../src/expectations.ts";

const roots: string[] = [];

const expectationId = "typescript-type-assignability";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-typescript-diagnostics-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: "bun test", typecheck: "tsc --noEmit" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, "src", "value.ts"), source);
  return root;
}

function assignabilityFindings(root: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === expectationId,
  );
}

describe("TypeScript diagnostic-to-finding adapter", () => {
  test("maps TS2322 into an advisory finding with compiler provenance", () => {
    const root = fixture("export const value: string = 123;\n");

    const analysis = analyzeExpectations(root);
    const findings = analysis.findings.filter((finding) => finding.expectationId === expectationId);
    const coverage = analysis.coverage.detectors.find((detector) => detector.id === expectationId);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      expectationId,
      expectationVersion: 1,
      policyKind: "advisory",
      severity: "warning",
      subject: { kind: "file", key: "src/value.ts", path: "src/value.ts" },
      requirement: { kind: "signal", key: "typescript-type-assignability" },
      verification: [["coding-tooling", "analyze", "--json"]],
    });
    expect(findings[0]?.analysisEvidence).toHaveLength(1);
    expect(findings[0]?.analysisEvidence?.[0]).toMatchObject({
      provider: "typescript-compiler",
      code: "TS2322",
      project: "tsconfig.json",
      location: { path: "src/value.ts", startLine: 1 },
    });
    expect(findings[0]?.analysisEvidence?.[0]?.providerVersion).toBeTruthy();
    expect(coverage).toMatchObject({ status: "applied", subjects: 1 });
    expect(findingsCommand(root).status).toBe("passed");
  });

  test("aggregates repeated TS2322 diagnostics by file and keeps the finding ID stable", () => {
    const root = fixture("export const first: string = 1;\nexport const second: string = 2;\n");

    const before = assignabilityFindings(root);
    expect(before).toHaveLength(1);
    expect(before[0]?.analysisEvidence).toHaveLength(2);

    writeFileSync(
      join(root, "src", "value.ts"),
      "\n\nexport const first: string = 1;\nexport const second: string = 2;\n",
    );
    const after = assignabilityFindings(root);

    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.analysisEvidence?.[0]?.location?.startLine).toBeGreaterThan(
      before[0]?.analysisEvidence?.[0]?.location?.startLine ?? 0,
    );
  });

  test("does not promote unrelated TypeScript compiler diagnostics", () => {
    const root = fixture("export const value = missingName;\n");

    expect(assignabilityFindings(root)).toEqual([]);
  });
});
