import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convergeRepository } from "../src/convergence.ts";
import { convergenceRulesCommand } from "../src/convergence-rules.ts";
import { executeGeneratorCommand } from "../src/generator-execution.ts";
import { normalizeRepository, planNormalization } from "../src/normalization.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-convergence-rules-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      scripts: {
        test: "bun test",
        "format:check": "oxfmt --check .",
        "format:write": "oxfmt .",
        lint: "oxlint .",
        "lint:fix": "oxlint --fix .",
      },
    })}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
  return root;
}

function configure(root: string, rules: Record<string, "disabled" | "suggest" | "apply">): void {
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify({ schemaVersion: 1, convergence: { rules } }, null, 2)}\n`,
  );
}

function localGenerator(root: string): void {
  const directory = join(root, ".coding-tooling", "generators", "sample");
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeFileSync(join(directory, "templates", "value.tmpl"), "export const generated = true;\n");
  writeFileSync(
    join(directory, "generator.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "sample",
      description: "Create a sample generated file.",
      rules: [],
      technologies: ["typescript"],
      inputs: {},
      target: { kind: "root" },
      operations: [{ kind: "create-file", template: "templates/value.tmpl", path: "generated.ts" }],
      compose: [],
      prerequisites: [],
      postconditions: [],
    })}\n`,
  );
}

function localBarrelGenerator(root: string): void {
  const directory = join(root, ".coding-tooling", "generators", "barrel");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), 'export * from "./existing";\n');
  writeFileSync(
    join(directory, "generator.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "barrel",
      description: "Add one deterministic barrel export.",
      rules: [],
      technologies: ["typescript"],
      inputs: {},
      target: { kind: "root" },
      operations: [{ kind: "typescript-barrel-export", path: "src/index.ts", module: "./service" }],
      compose: [],
      prerequisites: [],
      postconditions: [],
    })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("lists generators, scaffolders, refactors, and normalizers as first-class convergence rules", () => {
  const root = fixture();
  localGenerator(root);

  const result = convergenceRulesCommand(root, "list");
  const rules = result.data.rules as Array<{ id: string; kind: string; mode: string }>;

  expect(result.status).toBe("passed");
  expect(rules).toContainEqual(
    expect.objectContaining({ id: "generator.sample", kind: "generator", mode: "apply" }),
  );
  expect(rules).toContainEqual(
    expect.objectContaining({
      id: "scaffold.typescript-source-test",
      kind: "scaffold",
      mode: "apply",
    }),
  );
  expect(rules).toContainEqual(
    expect.objectContaining({
      id: "refactor.typescript-barrel-export",
      kind: "refactor",
      mode: "apply",
    }),
  );
  expect(rules).toContainEqual(
    expect.objectContaining({ id: "normalizer.oxfmt", kind: "normalizer", mode: "apply" }),
  );
  expect(rules).toContainEqual(
    expect.objectContaining({
      id: "normalizer.oxlint-safe-fix",
      kind: "normalizer",
      mode: "apply",
    }),
  );
});

test("disabling a scaffold keeps the finding but prevents convergence from mutating", () => {
  const root = fixture();
  configure(root, {
    "scaffold.typescript-source-test": "disabled",
    "normalizer.oxfmt": "disabled",
    "normalizer.oxlint-safe-fix": "disabled",
  });

  const result = convergeRepository(root, { verifyTier: null });
  const handoff = result.data.handoff as Array<Record<string, unknown>>;

  expect(result.status).toBe("passed");
  expect(result.data.result).toBe("partial");
  expect(existsSync(join(root, "tests", "service.test.ts"))).toBeFalse();
  expect(handoff).toContainEqual(
    expect.objectContaining({
      kind: "implementation",
      expectationIds: ["typescript-source-test"],
      convergenceRules: [{ id: "scaffold.typescript-source-test", mode: "disabled" }],
    }),
  );
});

test("suggest mode exposes an exact generator plan without applying it", () => {
  const root = fixture();
  localGenerator(root);
  configure(root, { "generator.sample": "suggest" });

  const result = executeGeneratorCommand(root, "sample", {});

  expect(result.status).toBe("unavailable");
  expect(result.data).toMatchObject({
    result: "rule-withheld",
    rules: [{ id: "generator.sample", mode: "suggest" }],
    withheldRules: [{ id: "generator.sample", mode: "suggest" }],
    plan: { generator: "sample" },
  });
  expect(existsSync(join(root, "generated.ts"))).toBeFalse();
});

test("structured refactors can be withheld independently from their generator", () => {
  const root = fixture();
  localBarrelGenerator(root);
  configure(root, { "refactor.typescript-barrel-export": "disabled" });
  const before = readFileSync(join(root, "src", "index.ts"), "utf8");

  const result = executeGeneratorCommand(root, "barrel", {});

  expect(result.status).toBe("unavailable");
  expect(result.data).toMatchObject({
    result: "rule-withheld",
    rules: [
      { id: "generator.barrel", mode: "apply" },
      { id: "refactor.typescript-barrel-export", mode: "disabled" },
    ],
    withheldRules: [{ id: "refactor.typescript-barrel-export", mode: "disabled" }],
  });
  expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toBe(before);
});

test("disabled normalizers remain discoverable but are not executed", () => {
  const root = fixture();
  configure(root, {
    "normalizer.oxfmt": "disabled",
    "normalizer.oxlint-safe-fix": "disabled",
  });

  const plan = planNormalization(root);
  expect(plan.normalizers).toContainEqual(
    expect.objectContaining({ ruleId: "normalizer.oxfmt", mode: "disabled" }),
  );
  expect(plan.normalizers).toContainEqual(
    expect.objectContaining({ ruleId: "normalizer.oxlint-safe-fix", mode: "disabled" }),
  );

  let executed = false;
  const result = normalizeRepository(root, {
    execute: () => {
      executed = true;
      throw new Error("disabled normalizer executed");
    },
  });

  expect(result.status).toBe("passed");
  expect(result.data.result).toBe("no-op");
  expect(executed).toBeFalse();
  expect(result.data.withheldNormalizers).toHaveLength(2);
});

test("rule commands persist enable, disable, and suggest state in repository config", () => {
  const root = fixture();

  const disabled = convergenceRulesCommand(root, "set", "normalizer.oxfmt", "disabled");
  expect(disabled.status).toBe("passed");
  expect(disabled.data.rule).toMatchObject({ id: "normalizer.oxfmt", mode: "disabled" });

  const configured = JSON.parse(readFileSync(join(root, ".coding-tooling.json"), "utf8"));
  expect(configured.convergence.rules["normalizer.oxfmt"]).toBe("disabled");

  const suggested = convergenceRulesCommand(root, "set", "normalizer.oxfmt", "suggest");
  expect(suggested.data.rule).toMatchObject({ id: "normalizer.oxfmt", mode: "suggest" });

  const enabled = convergenceRulesCommand(root, "set", "normalizer.oxfmt", "apply");
  expect(enabled.data.rule).toMatchObject({ id: "normalizer.oxfmt", mode: "apply" });
});
