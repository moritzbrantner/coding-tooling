import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { collectTestExecutionEvidence } from "../src/test-execution-evidence.ts";

const roots: string[] = [];

function repository(scripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-execution-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture", scripts })}\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native test execution evidence", () => {
  test("records executed, skipped, and TODO Bun cases separately", () => {
    const root = repository();
    const result = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["bun", "test"],
      stdout: "2 pass\n0 fail\n1 skip\n1 todo\nRan 4 tests across 1 file.",
      stderr: "",
    });

    expect(result).toMatchObject({
      status: "available",
      runner: "bun",
      executedCases: 2,
      passedCases: 2,
      failedCases: 0,
      skippedCases: 1,
      todoCases: 1,
    });
  });

  test("records a successful Bun process with no tests as zero executed cases", () => {
    const root = repository();
    const result = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["bun", "test"],
      stdout: "0 tests\n0 pass\n0 fail",
      stderr: "",
    });

    expect(result).toMatchObject({ status: "available", runner: "bun", executedCases: 0 });
  });

  test("parses Vitest summaries without counting skipped cases as executed", () => {
    const root = repository();
    const result = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["vitest", "run"],
      stdout: " Test Files  2 passed (2)\n      Tests  3 passed | 2 skipped (5)",
      stderr: "",
    });

    expect(result).toMatchObject({
      status: "available",
      runner: "vitest",
      executedCases: 3,
      passedCases: 3,
      skippedCases: 2,
    });
  });

  test("records a Vitest no-files result as zero executed cases", () => {
    const root = repository();
    const result = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["vitest", "run"],
      stdout: "No test files found, exiting with code 0",
      stderr: "",
    });

    expect(result).toMatchObject({ status: "available", runner: "vitest", executedCases: 0 });
  });

  test("follows bounded package-script wrappers to a native runner", () => {
    const root = repository({
      "test:unit": "bun run test:implementation",
      "test:implementation": "bun test",
    });
    const result = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["bun", "run", "test:unit"],
      stdout: "4 pass\n0 fail",
      stderr: "",
    });

    expect(result).toMatchObject({
      status: "available",
      runner: "bun",
      script: "test:implementation",
      executedCases: 4,
    });
  });

  test("reports cyclic package-script wrappers as unsupported instead of guessing", () => {
    const root = repository({
      "test:unit": "bun run test:implementation",
      "test:implementation": "bun run test:unit",
    });
    const result = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["bun", "run", "test:unit"],
      stdout: "",
      stderr: "",
    });

    expect(result).toMatchObject({
      status: "unsupported",
      runner: null,
      executedCases: null,
      reason: "package-script-cycle",
    });
  });

  test("does not reinterpret non-test capabilities as test execution", () => {
    const root = repository();
    expect(
      collectTestExecutionEvidence({
        cwd: root,
        capability: "build",
        command: ["bun", "run", "build"],
        stdout: "2 pass",
        stderr: "",
      }),
    ).toBeUndefined();
  });
});
