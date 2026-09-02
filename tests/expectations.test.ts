import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeExpectations,
  baselineFindings,
  findingsCommand,
  scaffoldFinding,
} from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-expectations-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          lint: "oxlint .",
          typecheck: "tsc --noEmit",
          test: "bun test",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        requiredCapabilities: ["format:check"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "src", "cli.ts"), "export const cli = true;\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
  return root;
}

describe("repository expectations", () => {
  test("discovers representative missing puzzle pieces deterministically", () => {
    const root = fixture();
    const findings = analyzeExpectations(root).findings;

    expect(new Set(findings.map((finding) => finding.expectationId))).toEqual(
      new Set([
        "package-aggregate-check",
        "package-cli-wiring",
        "required-capability-available",
        "typescript-project-config",
        "typescript-source-test",
      ]),
    );
    expect(
      findings.filter((finding) => finding.expectationId === "typescript-source-test"),
    ).toHaveLength(2);
    expect(findings.every((finding) => finding.state === "new")).toBeTrue();
    expect(findings.every((finding) => finding.severity === "warning")).toBeTrue();
  });

  test("accepts a differently named test that directly imports the source", () => {
    const root = fixture();
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "service-contract.test.ts"),
      'import { service } from "../src/service.ts";\nvoid service;\n',
    );

    expect(
      analyzeExpectations(root).findings.some(
        (finding) =>
          finding.expectationId === "typescript-source-test" &&
          finding.subject.key === "src/service.ts",
      ),
    ).toBeFalse();
  });

  test("keeps semantic finding IDs stable across unrelated repository changes", () => {
    const root = fixture();
    const before = analyzeExpectations(root).findings.map((finding) => finding.id);

    writeFileSync(join(root, "README.md"), "unrelated\n");

    expect(analyzeExpectations(root).findings.map((finding) => finding.id)).toEqual(before);
  });

  test("baselines current debt without hiding it or allowing it to block", () => {
    const root = fixture();
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcement: { "typescript-source-test": "error" },
        },
        null,
        2,
      )}\n`,
    );

    expect(findingsCommand(root).status).toBe("failed");
    expect(baselineFindings(root).status).toBe("passed");

    const after = findingsCommand(root);
    expect(after.status).toBe("passed");
    const findings = after.data.findings as Array<{ state: string }>;
    expect(findings.every((finding) => finding.state === "baseline")).toBeTrue();
  });

  test("suppresses only the explicitly accepted finding", () => {
    const root = fixture();
    const cliFinding = analyzeExpectations(root).findings.find(
      (finding) => finding.expectationId === "package-cli-wiring",
    );
    expect(cliFinding).toBeDefined();
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          suppressions: [{ id: cliFinding!.id, reason: "fixture intentionally has no bin" }],
        },
        null,
        2,
      )}\n`,
    );

    const findings = analyzeExpectations(root).findings;
    expect(findings.some((finding) => finding.id === cliFinding!.id)).toBeFalse();
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scaffolds a missing Bun test and resolves the finding", () => {
    const root = fixture();
    const finding = analyzeExpectations(root).findings.find(
      (item) =>
        item.expectationId === "typescript-source-test" && item.subject.key === "src/service.ts",
    );
    expect(finding).toBeDefined();

    const result = scaffoldFinding(root, finding!.id);

    expect(result.status).toBe("passed");
    expect(existsSync(join(root, "tests", "service.test.ts"))).toBeTrue();
    expect(analyzeExpectations(root).findings.some((item) => item.id === finding!.id)).toBeFalse();
  });
});
