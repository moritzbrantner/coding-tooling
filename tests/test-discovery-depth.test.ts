import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  collectTestDiscoveryEvidence,
  reconcileTestScope,
} from "../src/test-discovery-evidence.ts";
import { collectTestExecutionEvidence } from "../src/test-execution-evidence.ts";
import type { CommandResult } from "../src/shared.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("discovers Bun tests below the historical directory-depth limit", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-discovery-depth-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');

  const deepDirectory = Array.from({ length: 13 }, (_, index) => `level-${index}`).join("/");
  const deepTest = `${deepDirectory}/deep.test.ts`;
  mkdirSync(join(root, deepDirectory), { recursive: true });
  writeFileSync(join(root, deepTest), "export {};\n");

  const calls: string[][] = [];
  const runner = (command: string, args: string[] = []): CommandResult => {
    calls.push([command, ...args]);
    return { command: [command, ...args], status: 0, stdout: "", stderr: "" };
  };

  const discovery = collectTestDiscoveryEvidence(
    {
      cwd: root,
      capability: "test:unit",
      command: ["bun", "test"],
    },
    runner,
  );
  const execution = collectTestExecutionEvidence({
    cwd: root,
    capability: "test:unit",
    command: ["bun", "test"],
    stdout: "1 pass\n0 fail\nRan 1 test across 1 file.",
    stderr: "",
  });

  expect(discovery).toMatchObject({
    status: "available",
    conventionalCandidateFileCount: 1,
    discoveredFileCount: 1,
    discoveredFiles: [deepTest],
  });
  expect(reconcileTestScope(discovery, execution)).toMatchObject({
    status: "matched",
    discoveredFiles: 1,
    executedFiles: 1,
  });
  expect(calls).toEqual([["bun", "test", "--dry-run"]]);
});
