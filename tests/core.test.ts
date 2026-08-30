import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { discoverComponents, planChecks, runPlan } from "../src/core.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        lint: "oxlint .",
        typecheck: "tsc --noEmit",
        "test:unit": "bun test",
        build: "vite build",
        "dependencies:audit": "bun audit",
      },
      devDependencies: { react: "1", vite: "1" },
    }),
  );
  writeFileSync(join(root, "tsconfig.json"), "{}");
  mkdirSync(join(root, "src"));
  return root;
}

function addRustComponent(root: string): void {
  const rust = join(root, "crates", "backend");
  mkdirSync(join(rust, "src"), { recursive: true });
  writeFileSync(
    join(rust, "Cargo.toml"),
    '[package]\nname = "backend"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  writeFileSync(join(rust, "src", "lib.rs"), "");
}

function addConventionEnforcement(root: string, name: string, value: unknown): void {
  const directory = join(root, ".conventions", "modules", "test");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

describe("coding-tooling plans", () => {
  test("discovers semantic package capabilities", () => {
    const root = repository();
    const [component] = discoverComponents(root);
    expect(component.name).toBe("fixture");
    expect(component.technologies).toContain("typescript");
    expect(component.capabilities.lint).toEqual(["npm", "run", "lint"]);
  });

  test("does not discover fixture manifests as repository components", () => {
    const root = repository();
    const fixture = join(root, "fixtures", "sample");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture-sample" }));

    expect(discoverComponents(root).map((component) => component.name)).toEqual(["fixture"]);
  });

  test("creates a deterministic fast plan without treating absent capabilities as requirements", () => {
    const root = repository();
    const plan = planChecks({ root, tier: "fast" });
    expect(plan.checks.map((check) => check.capability)).toEqual([
      "lint",
      "typecheck",
      "test:unit",
      "build",
    ]);
    expect(plan.missing).toEqual([]);
  });

  test("full tier runs each capability only where it is applicable", () => {
    const root = repository();
    addRustComponent(root);

    const plan = planChecks({ root, tier: "full" });

    expect(plan.checks.map((check) => `${check.component}:${check.capability}`)).toEqual([
      "fixture:lint",
      "fixture:typecheck",
      "fixture:test:unit",
      "fixture:build",
      "backend:format:check",
      "backend:lint",
      "backend:test:unit",
      "backend:test:integration",
      "backend:build",
    ]);
    expect(plan.missing).toEqual([]);
  });

  test("installed conventions can require an additional full-tier capability", () => {
    const root = repository();
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.scripts["storybook:check"] = "storybook build && storybook test";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    addConventionEnforcement(root, "STORYBOOK-002.json", {
      schemaVersion: 1,
      ruleId: "STORYBOOK-002",
      enforcement: {
        kind: "capability",
        capability: "storybook:check",
        tiers: ["full"],
      },
    });

    const plan = planChecks({ root, tier: "full" });
    expect(plan.conventionRequiredCapabilities).toEqual(["storybook:check"]);
    expect(plan.checks.map((check) => check.capability)).toContain("storybook:check");
    expect(plan.missing).toEqual([]);
  });

  test("installed convention gates are reported missing when their canonical script is absent", () => {
    const root = repository();
    addConventionEnforcement(root, "LIGHTHOUSE-001.json", {
      schemaVersion: 1,
      ruleId: "LIGHTHOUSE-001",
      enforcement: {
        kind: "capability",
        capability: "web:audit",
        tiers: ["full"],
      },
    });

    const plan = planChecks({ root, tier: "full" });
    expect(plan.missing).toContainEqual({
      capability: "web:audit",
      component: "fixture",
      optional: false,
    });
  });

  test("required capabilities are satisfied across the selected component scope", () => {
    const root = repository();
    addRustComponent(root);
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        requiredCapabilities: ["typecheck"],
      }),
    );

    const repositoryPlan = planChecks({ root, tier: "full" });
    expect(repositoryPlan.missing).toEqual([]);

    const rustPlan = planChecks({ root, tier: "full", component: "backend" });
    expect(rustPlan.missing).toEqual([
      { capability: "typecheck", component: "backend", optional: false },
    ]);
  });

  test("reports a required capability when the selected scope cannot provide it", () => {
    const root = repository();
    addRustComponent(root);
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        requiredCapabilities: ["test:e2e"],
      }),
    );

    const plan = planChecks({ root, tier: "full" });
    expect(plan.missing).toEqual([
      { capability: "test:e2e", component: "selected components", optional: false },
    ]);
  });

  test("classifies unavailable dependency-update evidence as required or optional", () => {
    const root = repository();
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        tiers: {
          "dependency-update": [
            "lint",
            "test:integration",
            "dependencies:audit",
            "benchmark:smoke",
          ],
        },
        requiredCapabilities: ["lint", "dependencies:audit"],
        optionalCapabilities: ["test:integration", "benchmark:smoke"],
        capabilityCommands: {
          ".": {
            "benchmark:smoke": ["bun", "run", "bench:smoke"],
          },
        },
      }),
    );

    const plan = planChecks({ root, tier: "dependency-update" });
    expect(plan.checks.map((check) => check.capability)).toEqual([
      "lint",
      "dependencies:audit",
      "benchmark:smoke",
    ]);
    expect(plan.checks.at(-1)?.command).toEqual(["bun", "run", "bench:smoke"]);
    expect(plan.missing).toEqual([
      { capability: "test:integration", component: "fixture", optional: true },
    ]);
  });

  test("stops a validation tier after the first failed check", () => {
    const root = repository();
    const marker = join(root, "should-not-run");
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        tiers: { failFast: ["lint", "typecheck"] },
        capabilityCommands: {
          ".": {
            lint: ["node", "-e", "process.exit(1)"],
            typecheck: [
              "node",
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            ],
          },
        },
      }),
    );

    const result = runPlan({ root, tier: "failFast" });
    expect(result.status).toBe("failed");
    expect((result.data.results as unknown[]).length).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  test("rejects contradictory required and optional capability policy", () => {
    const root = repository();
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        requiredCapabilities: ["lint"],
        optionalCapabilities: ["lint"],
      }),
    );

    expect(() => planChecks({ root, tier: "fast" })).toThrow(
      "lint cannot be both required and optional",
    );
  });
});
