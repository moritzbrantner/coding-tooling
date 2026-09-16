import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  collectTestDiscoveryEvidence,
  reconcileTestScope,
} from "../src/test-discovery-evidence.ts";
import { collectTestExecutionEvidence } from "../src/test-execution-evidence.ts";
import type { CommandResult } from "../src/shared.ts";

const roots: string[] = [];

function repository(scripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-discovery-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture", scripts })}\n`);
  return root;
}

function file(root: string, path: string, content = "export {};\n"): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function successfulRunner(stdout = "") {
  const calls: string[][] = [];
  return {
    calls,
    run(command: string, args: string[] = []): CommandResult {
      calls.push([command, ...args]);
      return { command: [command, ...args], status: 0, stdout, stderr: "" };
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native test discovery evidence", () => {
  test("discovers conventional Bun test files and proves the native dry-run is available", () => {
    const root = repository();
    file(root, "tests/alpha.test.ts");
    file(root, "tests/beta_spec.ts");
    file(root, "src/not-a-test.ts");
    const runner = successfulRunner();

    const result = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["bun", "test"],
      },
      runner.run,
    );

    expect(result).toMatchObject({
      status: "available",
      runner: "bun",
      strategy: "bun-dry-run",
      conventionalCandidateFileCount: 2,
      discoveredFileCount: 2,
      excludedFileCount: 0,
      discoveredFiles: ["tests/alpha.test.ts", "tests/beta_spec.ts"],
    });
    expect(runner.calls).toEqual([["bun", "test", "--dry-run"]]);
  });

  test("treats an explicit Bun file path as an exact filter", () => {
    const root = repository();
    file(root, "tests/alpha.test.ts");
    file(root, "tests/alpha-extra.test.ts");
    const runner = successfulRunner();

    const result = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["bun", "test", "./tests/alpha.test.ts"],
      },
      runner.run,
    );

    expect(result).toMatchObject({
      status: "available",
      discoveredFileCount: 1,
      discoveredFiles: ["tests/alpha.test.ts"],
      excludedFileCount: 1,
    });
  });

  test("reports conventional Bun tests excluded by runner configuration", () => {
    const root = repository();
    file(root, "kept.test.ts");
    file(root, "ignored/hidden.test.ts");
    writeFileSync(join(root, "bunfig.toml"), '[test]\npathIgnorePatterns = ["ignored/**"]\n');
    const runner = successfulRunner();

    const result = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["bun", "test"],
      },
      runner.run,
    );

    expect(result).toMatchObject({
      status: "available",
      conventionalCandidateFileCount: 2,
      discoveredFileCount: 1,
      excludedFileCount: 1,
      discoveredFiles: ["kept.test.ts"],
      excludedFiles: ["ignored/hidden.test.ts"],
    });
  });

  test("keeps nested package tests outside the parent component scope", () => {
    const root = repository();
    file(root, "tests/root.test.ts");
    file(root, "packages/child/package.json", '{"name":"child"}\n');
    file(root, "packages/child/tests/child.test.ts");
    const runner = successfulRunner();

    const result = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["bun", "test"],
        excludedSubtrees: ["packages/child"],
      },
      runner.run,
    );

    expect(result).toMatchObject({
      status: "available",
      conventionalCandidateFileCount: 1,
      discoveredFileCount: 1,
      conventionalCandidateFiles: ["tests/root.test.ts"],
    });
  });

  test("uses Vitest's native files-only listing as authoritative discovery", () => {
    const root = repository();
    file(root, "tests/included.test.ts");
    file(root, "tests/excluded.test.ts");
    const runner = successfulRunner("tests/included.test.ts\n");

    const result = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["vitest", "run", "--config", "vitest.config.ts"],
      },
      runner.run,
    );

    expect(result).toMatchObject({
      status: "available",
      runner: "vitest",
      strategy: "vitest-list",
      conventionalCandidateFileCount: 2,
      discoveredFileCount: 1,
      excludedFileCount: 1,
      discoveredFiles: ["tests/included.test.ts"],
      excludedFiles: ["tests/excluded.test.ts"],
    });
    expect(runner.calls).toEqual([
      ["vitest", "list", "--config", "vitest.config.ts", "--filesOnly"],
    ]);
  });

  test("fails closed when Vitest lists a test owned by a nested component", () => {
    const root = repository();
    file(root, "tests/root.test.ts");
    file(root, "packages/child/tests/child.test.ts");
    const runner = successfulRunner("packages/child/tests/child.test.ts\n");

    const result = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["vitest", "run"],
        excludedSubtrees: ["packages/child"],
      },
      runner.run,
    );

    expect(result).toMatchObject({
      status: "incomplete",
      runner: "vitest",
      reason: "vitest-discovery-cross-component",
    });

    const execution = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["vitest", "run"],
      stdout: "Test Files  1 passed (1)\nTests  1 passed (1)",
      stderr: "",
    });
    expect(reconcileTestScope(result, execution)).toMatchObject({
      status: "mismatch",
      reason: "native-discovery-cross-component",
    });
  });

  test("reconciles native discovery with the number of files reported by execution", () => {
    const root = repository();
    file(root, "tests/alpha.test.ts");
    file(root, "tests/beta.test.ts");
    const runner = successfulRunner();
    const discovery = collectTestDiscoveryEvidence(
      {
        cwd: root,
        capability: "test:unit",
        command: ["bun", "test"],
      },
      runner.run,
    );
    const execution = collectTestExecutionEvidence({
      cwd: root,
      capability: "test:unit",
      command: ["bun", "test"],
      stdout: "1 pass\n0 fail\nRan 1 test across 1 file.",
      stderr: "",
    });

    expect(reconcileTestScope(discovery, execution)).toEqual({
      schemaVersion: 1,
      status: "mismatch",
      discoveredFiles: 2,
      executedFiles: 1,
      reason: "native-discovery-execution-file-count-mismatch",
    });
  });
});
