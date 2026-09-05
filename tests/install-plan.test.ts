import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { dependencyInstallPlan } from "../src/install-plan.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-install-plan-"));
  writeJson(join(root, "package.json"), {
    name: "root-package",
    scripts: { build: "node -e process.exit(0)" },
  });
  writeJson(join(root, "packages", "nested", "package.json"), {
    name: "nested-package",
    scripts: { build: "node -e process.exit(0)" },
  });
  writeJson(join(root, ".coding-tooling.json"), {
    schemaVersion: 1,
    tiers: { fast: ["build"] },
  });
  return root;
}

type InstallStep = {
  path: string;
  manager: string;
  lockfile: string;
  command: string[];
  components: string[];
};

function steps(result: ReturnType<typeof dependencyInstallPlan>): InstallStep[] {
  return result.data.steps as InstallStep[];
}

describe("dependency install plan", () => {
  test("installs independently locked selected packages at their own roots", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeFileSync(join(root, "packages", "nested", "bun.lock"), "nested\n");

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("passed");
    expect(steps(result)).toEqual([
      {
        path: ".",
        manager: "bun",
        lockfile: "bun.lock",
        command: ["bun", "install", "--frozen-lockfile"],
        components: ["root-package"],
      },
      {
        path: "packages/nested",
        manager: "bun",
        lockfile: "bun.lock",
        command: ["bun", "install", "--frozen-lockfile"],
        components: ["nested-package"],
      },
    ]);
  });

  test("deduplicates packages owned by the same ancestor lockfile", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("passed");
    expect(steps(result)).toEqual([
      {
        path: ".",
        manager: "bun",
        lockfile: "bun.lock",
        command: ["bun", "install", "--frozen-lockfile"],
        components: ["nested-package", "root-package"],
      },
    ]);
  });

  test("honors the same component selector as validation planning", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeFileSync(join(root, "packages", "nested", "package-lock.json"), "{}\n");

    const result = dependencyInstallPlan({
      root,
      tier: "fast",
      component: "nested-package",
    });

    expect(result.status).toBe("passed");
    expect(steps(result)).toEqual([
      {
        path: "packages/nested",
        manager: "npm",
        lockfile: "package-lock.json",
        command: ["npm", "ci"],
        components: ["nested-package"],
      },
    ]);
  });

  test("reports selected packages without a supported owner lockfile as unavailable", () => {
    const root = repository();

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("unavailable");
    expect(steps(result)).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "dependency-install-lockfile-missing",
      "dependency-install-lockfile-missing",
    ]);
  });

  test("rejects ambiguous Bun and npm lock ownership", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "dependency-install-lockfile-conflict" }),
    );
  });
});
