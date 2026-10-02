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

  test("does not claim a root lock owns an unrelated nested package", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("unavailable");
    expect(steps(result)).toEqual([
      {
        path: ".",
        manager: "bun",
        lockfile: "bun.lock",
        command: ["bun", "install", "--frozen-lockfile"],
        components: ["root-package"],
      },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "dependency-install-lockfile-missing",
        path: "packages/nested",
      }),
    );
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

  test("ignores discovered packages that have no checks in the selected tier", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeFileSync(join(root, "packages", "nested", "bun.lock"), "nested\n");
    writeJson(join(root, "packages", "docs", "package.json"), {
      name: "docs-package",
      scripts: { lint: "node -e process.exit(0)" },
    });

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("passed");
    expect(
      (result.data.selectedComponents as Array<{ name: string }>).map(
        (component) => component.name,
      ),
    ).toEqual(["root-package", "nested-package"]);
  });

  test("reports selected packages without a supported component lockfile as unavailable", () => {
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
    writeFileSync(join(root, "packages", "nested", "bun.lock"), "nested\n");

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "dependency-install-lockfile-conflict", path: "." }),
    );
  });

  test("acquires locked Cargo dependencies next to package installation", () => {
    const root = repository();
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    writeFileSync(join(root, "packages", "nested", "bun.lock"), "nested\n");
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "root-crate"\nversion = "0.1.0"\n');
    writeFileSync(join(root, "Cargo.lock"), "version = 4\n");

    const result = dependencyInstallPlan({ root, tier: "fast" });

    expect(result.status).toBe("passed");
    expect(steps(result).map((step) => [step.path, step.manager, step.command])).toEqual([
      [".", "cargo", ["cargo", "fetch", "--locked"]],
      [".", "npm", ["npm", "ci"]],
      ["packages/nested", "bun", ["bun", "install", "--frozen-lockfile"]],
    ]);
  });

  test("leaves unlocked crates and source-development Cargo resolution to their own flows", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeFileSync(join(root, "packages", "nested", "bun.lock"), "nested\n");
    mkdirSync(join(root, "crates", "unlocked"), { recursive: true });
    writeFileSync(
      join(root, "crates", "unlocked", "Cargo.toml"),
      '[package]\nname = "unlocked"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "root-crate"\nversion = "0.1.0"\n');
    writeFileSync(join(root, "Cargo.lock"), "version = 4\n");
    writeJson(join(root, ".coding-tooling.source-deps.json"), {
      schemaVersion: 2,
      cargo: { localOnly: true },
    });

    const sourceMode = dependencyInstallPlan({ root, tier: "fast" });
    expect(sourceMode.status).toBe("passed");
    expect(steps(sourceMode).some((step) => step.manager === "cargo")).toBe(false);

    writeJson(join(root, ".coding-tooling.source-deps.json"), { schemaVersion: 2 });
    const distribution = dependencyInstallPlan({ root, tier: "fast" });
    expect(distribution.status).toBe("passed");
    expect(
      steps(distribution)
        .filter((step) => step.manager === "cargo")
        .map((step) => step.path),
    ).toEqual(["."]);
  });

  test("fetches locked crates that only convention enforcement inspects in the tier", () => {
    const root = repository();
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeFileSync(join(root, "packages", "nested", "bun.lock"), "nested\n");
    writeJson(join(root, ".coding-tooling.json"), {
      schemaVersion: 1,
      tiers: { fast: ["build"], performance: ["load:smoke"] },
    });
    mkdirSync(join(root, "crates", "engine"), { recursive: true });
    writeFileSync(
      join(root, "crates", "engine", "Cargo.toml"),
      '[package]\nname = "engine"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(root, "crates", "engine", "Cargo.lock"), "version = 4\n");

    const result = dependencyInstallPlan({ root, tier: "performance" });

    expect(result.data.planVersion).toBe(2);
    expect(result.data.selectedComponents).toEqual([]);
    expect(steps(result)).toEqual([
      {
        path: "crates/engine",
        manager: "cargo",
        lockfile: "Cargo.lock",
        command: ["cargo", "fetch", "--locked"],
        components: ["engine"],
      },
    ]);
  });
});
