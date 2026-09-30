import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { check, discoverComponents, inspect, planChecks, runPlan } from "../src/core.ts";

const roots: string[] = [];

function repository(configPath = ".coding-tooling.json", exitCode = 0): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-repository-capabilities-"));
  roots.push(root);
  writeFileSync(join(root, "validate.js"), `process.exit(${exitCode});\n`);
  writeFileSync(
    join(root, configPath),
    JSON.stringify({
      schemaVersion: 1,
      tiers: { full: ["package:check"] },
      requiredCapabilities: ["package:check"],
      capabilityCommands: { ".": { "package:check": [process.execPath, "validate.js"] } },
    }),
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit repository capabilities", () => {
  test("discovers an honest repository scope and plans its required root command", () => {
    const root = repository();
    expect(discoverComponents(root)).toEqual([
      {
        name: basename(root),
        path: ".",
        kind: "repository",
        technologies: [],
        capabilities: { "package:check": [process.execPath, "validate.js"] },
      },
    ]);
    expect(inspect(root).status).toBe("passed");
    const plan = planChecks({ root, tier: "full", component: "." });
    expect(plan.missing).toEqual([]);
    expect(plan.checks).toEqual([
      {
        component: basename(root),
        path: ".",
        capability: "package:check",
        command: [process.execPath, "validate.js"],
      },
    ]);
    expect(check(root, "package:check").status).toBe("passed");
  });

  test("strict execution uses the declared command and preserves failures", () => {
    expect(runPlan({ root: repository(), tier: "full", strict: true }).status).toBe("passed");
    expect(
      runPlan({ root: repository(".coding-tooling.json", 7), tier: "full", strict: true }).status,
    ).toBe("failed");
  });

  test("does not synthesize a scope from absent, empty or non-root declarations", () => {
    const root = repository();
    for (const capabilityCommands of [
      {},
      { ".": {} },
      { missing: { "package:check": [process.execPath, "validate.js"] } },
    ]) {
      writeFileSync(
        join(root, ".coding-tooling.json"),
        JSON.stringify({ schemaVersion: 1, capabilityCommands }),
      );
      expect(discoverComponents(root)).toEqual([]);
    }
    rmSync(join(root, ".coding-tooling.json"));
    expect(discoverComponents(root)).toEqual([]);
  });

  test("preserves language components and attaches root commands without duplication", () => {
    const root = repository();
    mkdirSync(join(root, "child"));
    writeFileSync(join(root, "child", "package.json"), '{"name":"child"}\n');
    expect(discoverComponents(root).map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: ".", kind: "repository" },
      { path: "child", kind: "package" },
    ]);
    writeFileSync(join(root, "package.json"), '{"name":"root"}\n');
    expect(discoverComponents(root).map(({ kind }) => kind)).toEqual(["package", "package"]);
    expect(planChecks({ root, tier: "full" }).checks).toHaveLength(1);
  });

  test("supports an alternate config path in planning and execution", () => {
    const root = repository("tooling.json");
    expect(discoverComponents(root)).toEqual([]);
    expect(planChecks({ root, tier: "full", configPath: "tooling.json" }).missing).toEqual([]);
    expect(runPlan({ root, tier: "full", configPath: "tooling.json", strict: true }).status).toBe(
      "passed",
    );
  });

  test("the CLI runs required repository commands with strict exit semantics", () => {
    const root = repository();
    const child = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "run",
        "--tier",
        "full",
        "--strict",
        "--json",
      ],
      { cwd: root },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      status: "passed",
      data: { missing: [], results: [{ status: "passed" }] },
    });
  });
});
