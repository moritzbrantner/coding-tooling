import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations, scaffoldFinding } from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("turns a missing-test scaffold into exact residual implementation work", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-handoff-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"fixture","scripts":{"test":"bun test"}}\n');
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

  const before = analyzeExpectations(root).findings;
  const missingTest = before.find((finding) => finding.expectationId === "typescript-source-test");
  expect(missingTest?.scaffold?.path).toBe("tests/service.test.ts");

  const scaffold = scaffoldFinding(root, missingTest!.id);
  expect(scaffold.status).toBe("passed");

  const generated = readFileSync(join(root, "tests", "service.test.ts"), "utf8");
  expect(generated).toMatch(/TODO: \[coding-tooling:test-[a-f0-9]{12}\]/);

  const after = analyzeExpectations(root).findings;
  expect(after.some((finding) => finding.id === missingTest!.id)).toBeFalse();
  expect(after).toContainEqual(
    expect.objectContaining({
      expectationId: "source-work-marker",
      severity: "warning",
      subject: expect.objectContaining({
        path: "tests/service.test.ts",
        description: expect.stringContaining("tests/service.test.ts:4"),
      }),
      requirement: expect.objectContaining({
        description:
          "Replace this scaffold with meaningful deterministic assertions for src/service.ts.",
      }),
      relatedFiles: ["tests/service.test.ts"],
    }),
  );
});
