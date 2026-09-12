import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { analyzeExpectations } from "../src/expectations.ts";

const roots: string[] = [];

function repository(testSource: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-state-"));
  roots.push(root);
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: "bun test" } })}\n`,
  );
  writeFileSync(join(root, "tests", "state.test.ts"), testSource);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function findings(root: string, expectationId: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === expectationId,
  );
}

describe("test case state expectations", () => {
  test("reports focused-only test cases", () => {
    const root = repository(`import { describe, test } from "bun:test";

describe("suite", () => {
  test.only("focused", () => {});
  test("normal", () => {});
});
`);

    const focused = findings(root, "test-focused-case");
    expect(focused).toHaveLength(1);
    expect(focused[0]?.subject.path).toBe("tests/state.test.ts");
    expect(focused[0]?.message).toContain("test.only");
  });

  test("keeps skipped and TODO cases visible as explicit debt", () => {
    const root = repository(`import { describe, test } from "bun:test";

describe.skip("disabled suite", () => {});
test.skip("disabled case", () => {});
test.todo("unfinished case");
`);

    const disabled = findings(root, "test-disabled-case");
    expect(disabled.map((finding) => finding.message)).toEqual([
      expect.stringContaining("describe.skip"),
      expect.stringContaining("test.skip"),
      expect.stringContaining("test.todo"),
    ]);
  });

  test("ignores comments, strings, aliases, and unsupported describe.todo", () => {
    const root = repository(`import { describe, test } from "bun:test";

// test.only("line commented", () => {});
/*
test.only("block commented", () => {});
test.skip("also block commented", () => {});
*/
const text = \`
test.only("template text", () => {});
test.todo("template text", () => {});
\`;
const focused = test.only;
focused("aliased", () => {});
describe.todo("unsupported shape", () => {});
test("normal", () => {});
`);

    expect(findings(root, "test-focused-case")).toEqual([]);
    expect(findings(root, "test-disabled-case")).toEqual([]);
  });

  test("still recognizes active calls after an inline block comment", () => {
    const root = repository(`import { test } from "bun:test";\n/* reviewed */ test.only("focused", () => {});\n`);

    expect(findings(root, "test-focused-case")).toHaveLength(1);
  });

  test("reports detector coverage against discovered test files", () => {
    const root = repository(`import { test } from "bun:test";\ntest("normal", () => {});\n`);
    const coverage = analyzeExpectations(root).coverage.detectors;

    expect(coverage.find((item) => item.id === "test-focused-case")).toMatchObject({
      status: "applied",
      subjects: 1,
    });
    expect(coverage.find((item) => item.id === "test-disabled-case")).toMatchObject({
      status: "applied",
      subjects: 1,
    });
  });
});
