import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { conventionRegistryCommand } from "../src/convention-registry.ts";
import { planChecks } from "../src/core.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

function conventionSource(): string {
  const root = workspace("versioned-runner-source-");
  write(root, "README.md", "# Conventions\n");
  write(root, "principles/README.md", "## PRINCIPLE-001 — Be explicit\n");
  write(root, "conventions/README.md", "# General conventions\n");
  write(root, "technologies/typescript/README.md", "## TS-003 — Prefer type aliases\n");
  write(
    root,
    "technologies/typescript/TS-003.oxlint.json",
    `${JSON.stringify(
      { rules: { "typescript/consistent-type-definitions": ["error", "type"] } },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    "registry/registry.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        modules: {
          base: { sources: ["principles/README.md"], dependencies: [] },
          typescript: {
            sources: ["technologies/typescript/README.md"],
            assets: ["technologies/typescript/TS-003.oxlint.json"],
            configurations: [
              {
                rule: "TS-003",
                path: "technologies/typescript/TS-003.oxlint.json",
                tool: "oxlint",
                capability: "lint",
              },
            ],
            dependencies: ["base"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function consumer(lintScript: string): string {
  const root = workspace("versioned-runner-consumer-");
  write(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "consumer",
        scripts: { lint: lintScript },
      },
      null,
      2,
    )}\n`,
  );
  write(root, "bun.lock", "");
  write(root, "tsconfig.json", "{}\n");
  write(
    root,
    ".coding-tooling.json",
    `${JSON.stringify({ schemaVersion: 1, tiers: { lintOnly: ["lint"] } }, null, 2)}\n`,
  );
  return root;
}

function installAndPlan(source: string, target: string): string[] {
  expect(
    conventionRegistryCommand("init", ["typescript"], {
      root: target,
      conventionsRoot: source,
    }).status,
  ).toBe("passed");
  const plan = planChecks({ root: target, tier: "lintOnly" });
  expect(plan.checks).toHaveLength(1);
  return plan.checks[0]!.command;
}

describe("version-qualified convention tool runners", () => {
  test.each([
    "bunx oxlint@1.81.0 src examples tests benchmarks",
    "npx oxlint@1.81.0 src",
    "pnpm dlx oxlint@1.81.0 src",
    "yarn dlx oxlint@1.81.0 src",
  ])("recognizes exact version-qualified Oxlint scripts: %s", (script) => {
    const source = conventionSource();
    const target = consumer(script);
    try {
      const command = installAndPlan(source, target);
      expect(command.slice(0, 4)).toEqual(["bun", "run", "lint", "--config"]);
      expect(command).toContain("--disable-nested-config");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("keeps non-exact package aliases outside the safe adapter", () => {
    const source = conventionSource();
    const target = consumer("bunx oxlint@npm:eslint src");
    try {
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      expect(() => planChecks({ root: target, tier: "lintOnly" })).toThrow(
        "Cannot safely identify oxlint as the package-script entrypoint",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("keeps compound package scripts rejected", () => {
    const source = conventionSource();
    const target = consumer("bunx oxlint@1.81.0 src && echo done");
    try {
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      expect(() => planChecks({ root: target, tier: "lintOnly" })).toThrow(
        "compound package script",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
