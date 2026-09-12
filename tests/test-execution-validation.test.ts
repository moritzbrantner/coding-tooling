import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { runPlan } from "../src/core.ts";

const roots: string[] = [];

function repository(testSource: string, testScript = "bun test tests/unit.test.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-validation-"));
  roots.push(root);
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      scripts: { "test:unit": testScript },
    })}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tests", "unit.test.ts"), testSource);
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      tiers: { probe: ["test:unit"] },
      requiredCapabilities: ["test:unit"],
    })}\n`,
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("test execution validation", () => {
  test("fails a passing native runner process that executes zero behavioral cases", () => {
    const root = repository(
      `import { test } from "bun:test";\ntest.skip("not executed", () => {});\n`,
    );
    const result = runPlan({ root, tier: "probe", strict: true });
    const completed = (result.data.results as Array<Record<string, unknown>>)[0];

    expect(result.status).toBe("failed");
    expect(completed).toMatchObject({
      capability: "test:unit",
      status: "failed",
      processStatus: "passed",
      exitCode: 0,
      failureReason: "zero-tests-executed",
      testExecution: {
        status: "available",
        runner: "bun",
        executedCases: 0,
        skippedCases: 1,
      },
    });
    expect(result.diagnostics).toContainEqual({
      code: "test-zero-executed-cases",
      message: "test:unit for fixture completed without executing a behavioral test case",
    });
  });

  test("passes when the native runner reports an executed behavioral case", () => {
    const root = repository(
      `import { expect, test } from "bun:test";\ntest("executed", () => expect(1 + 1).toBe(2));\n`,
    );
    const result = runPlan({ root, tier: "probe", strict: true });
    const completed = (result.data.results as Array<Record<string, unknown>>)[0];

    expect(result.status).toBe("passed");
    expect(completed).toMatchObject({
      capability: "test:unit",
      status: "passed",
      processStatus: "passed",
      testExecution: {
        status: "available",
        runner: "bun",
        executedCases: 1,
        passedCases: 1,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("does not replace a native runner process failure with a zero-test diagnostic", () => {
    const root = repository(
      `import { test } from "bun:test";\ntest("unused", () => {});\n`,
      "bun test tests/missing.test.ts",
    );
    const result = runPlan({ root, tier: "probe", strict: true });
    const completed = (result.data.results as Array<Record<string, unknown>>)[0];

    expect(result.status).toBe("failed");
    expect(completed).toMatchObject({
      capability: "test:unit",
      status: "failed",
      processStatus: "failed",
      failureReason: undefined,
    });
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "test-zero-executed-cases" }),
    );
  });
});
