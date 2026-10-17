import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  executionText,
  runAnchoredTest,
  selectReportExecution,
  type RevisionHistory,
} from "../src/decision-atlas-execution.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "atlas-execution-unit-"));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git("init", "-q");
  git("config", "user.name", "unit");
  git("config", "user.email", "unit@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { root, head: git("rev-parse", "HEAD") };
}

const passingBunTest = `import { test } from "bun:test";\ntest("ok", () => {});\n`;

test("execution text names the revision only for a non-current result", () => {
  expect(executionText({ status: "not-run", current: false })).toBe("execution: not-run");
  expect(executionText({ status: "failed", revision: "a".repeat(40), current: true })).toBe(
    "execution: failed",
  );
  expect(executionText({ status: "passed", revision: "b".repeat(40), current: false })).toBe(
    "execution: passed at " + "b".repeat(12),
  );
});

test("an exact current revision beats an equivalent abbreviated one; unknown revisions are ignored", () => {
  const head = "c".repeat(40);
  const history: RevisionHistory = {
    distance: (revision) => (revision === "ccccccc" ? 0 : undefined),
  };
  const results = [
    { outcome: "failed" as const, revision: "ccccccc", reportPath: "a.json" },
    { outcome: "passed" as const, revision: head, reportPath: "b.json" },
    { outcome: "failed" as const, revision: "not-a-commit", reportPath: "c.json" },
  ];
  expect(selectReportExecution(results, head, history)).toEqual({
    status: "passed",
    revision: head,
    current: true,
    source: "report",
    reportPath: "b.json",
  });
  expect(selectReportExecution(results.slice(2), head, history)).toEqual({
    status: "not-run",
    current: false,
  });
  expect(selectReportExecution(results, undefined, history)).toEqual({
    status: "not-run",
    current: false,
  });
});

test("a run needs a clean tracked tree so the result is evidence at HEAD", () => {
  const { root, head } = repo({ "tests/a.test.ts": passingBunTest });
  expect(runAnchoredTest(root, head, "tests/a.test.ts", "ok")).toEqual({
    status: "passed",
    revision: head,
    current: true,
    source: "run",
  });
  writeFileSync(join(root, "tests/a.test.ts"), passingBunTest + "// edited\n");
  expect(runAnchoredTest(root, head, "tests/a.test.ts", "ok")).toEqual({
    status: "not-run",
    current: false,
  });
}, 60_000);

test("a non-Bun TypeScript test and a test name that matches nothing are not run", () => {
  const { root, head } = repo({
    "tests/v.test.ts": `import { test } from "vitest";\ntest("ok", () => {});\n`,
    "tests/a.test.ts": passingBunTest,
  });
  expect(runAnchoredTest(root, head, "tests/v.test.ts", "ok").status).toBe("not-run");
  expect(runAnchoredTest(root, head, "tests/a.test.ts", "missing").status).toBe("not-run");
}, 60_000);
