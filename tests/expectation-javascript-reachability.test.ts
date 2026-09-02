import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations } from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(scripts: Record<string, string> = { test: "node --test" }): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-js-reachability-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts }, null, 2)}\n`,
  );
  return root;
}

function javascriptFindings(root: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === "javascript-source-test",
  );
}

describe("JavaScript structural test reachability", () => {
  test("reports production JavaScript source with no structural test evidence", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "service.js"), "export const service = true;\n");

    const findings = javascriptFindings(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.subject.key).toBe("src/service.js");
    expect(findings[0]?.requirement.expectedArtifact).toBe("tests/service.test.js");
    expect(findings[0]?.scaffold).toBeUndefined();
  });

  test("accepts direct relative import evidence", () => {
    const root = fixture();
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "service.js"), "export const service = true;\n");
    writeFileSync(
      join(root, "tests", "contract.test.js"),
      'import { service } from "../src/service.js";\nvoid service;\n',
    );

    expect(javascriptFindings(root)).toEqual([]);
  });

  test("accepts conservative transitive require reachability", () => {
    const root = fixture();
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "leaf.cjs"), "exports.value = 1;\n");
    writeFileSync(join(root, "src", "service.cjs"), 'require("./leaf.cjs");\n');
    writeFileSync(join(root, "tests", "service.test.cjs"), 'require("../src/service.cjs");\n');

    expect(javascriptFindings(root)).toEqual([]);
  });

  test("excludes stories fixtures and test-support roots", () => {
    const root = fixture();
    mkdirSync(join(root, "src", "tests"), { recursive: true });
    writeFileSync(join(root, "src", "widget.stories.jsx"), "export const Story = {};\n");
    writeFileSync(join(root, "src", "sample.fixture.js"), "export const sample = {};\n");
    writeFileSync(join(root, "src", "tests", "helper.js"), "export const helper = true;\n");

    expect(javascriptFindings(root)).toEqual([]);
  });

  test("package test capability finding covers JavaScript source without a test command", () => {
    const root = fixture({ lint: "oxlint ." });
    writeFileSync(join(root, "src", "service.js"), "export const service = true;\n");

    const findings = analyzeExpectations(root).findings;

    expect(
      findings.some((finding) => finding.expectationId === "package-test-capability"),
    ).toBeTrue();
    expect(javascriptFindings(root)).toEqual([]);
  });

  test("mixed JavaScript and TypeScript sources keep separate semantic findings", () => {
    const root = fixture();
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "src", "javascript.js"), "export const js = true;\n");
    writeFileSync(join(root, "src", "typescript.ts"), "export const ts = true;\n");

    const findings = analyzeExpectations(root).findings.filter((finding) =>
      ["javascript-source-test", "typescript-source-test"].includes(finding.expectationId),
    );

    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.subject.key))).toEqual(
      new Set(["src/javascript.js", "src/typescript.ts"]),
    );
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
  });
});
