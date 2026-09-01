import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyGeneratorCommand, applyGeneratorPlan } from "../src/generator-apply.ts";
import { planGenerator } from "../src/generators.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-generator-apply-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function localGenerator(
  root: string,
  id: string,
  operations: unknown[],
  compose: unknown[] = [],
): void {
  const directory = join(root, ".coding-tooling", "generators", id);
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeJson(join(directory, "generator.json"), {
    schemaVersion: 1,
    id,
    description: `${id} fixture`,
    rules: [],
    technologies: ["typescript"],
    inputs: { name: { type: "identifier", required: true } },
    target: { kind: "root" },
    operations,
    compose,
    prerequisites: [],
    postconditions: [],
  });
}

function createFileGenerator(root: string, id = "feature"): void {
  localGenerator(root, id, [
    {
      kind: "create-file",
      template: "templates/file.tmpl",
      path: "{{name | pascal}}/{{name | kebab}}.ts",
    },
  ]);
  const directory = join(root, ".coding-tooling", "generators", id);
  writeFileSync(join(directory, "templates", "file.tmpl"), "export const name = '{{name}}';\n");
}

describe("generator apply", () => {
  test("creates a scaffold and becomes an idempotent no-op on repeat", () => {
    const root = fixture();
    createFileGenerator(root);

    const first = applyGeneratorCommand(root, "feature", { name: "UserProfile" });
    expect(first.status).toBe("passed");
    expect((first.data.generation as { result: string }).result).toBe("generated");
    expect(readFileSync(join(root, "UserProfile", "user-profile.ts"), "utf8")).toBe(
      "export const name = 'UserProfile';\n",
    );

    const second = applyGeneratorCommand(root, "feature", { name: "UserProfile" });
    expect(second.status).toBe("passed");
    expect((second.data.generation as { result: string }).result).toBe("no-op");
  });

  test("refuses to overwrite user-owned source", () => {
    const root = fixture();
    createFileGenerator(root);
    mkdirSync(join(root, "UserProfile"), { recursive: true });
    writeFileSync(join(root, "UserProfile", "user-profile.ts"), "user edit\n");

    const result = applyGeneratorCommand(root, "feature", { name: "UserProfile" });
    expect(result.status).toBe("failed");
    expect((result.data.generation as { result: string }).result).toBe("generation-conflict");
    expect(readFileSync(join(root, "UserProfile", "user-profile.ts"), "utf8")).toBe("user edit\n");
  });

  test("performs a narrow idempotent JSON set without replacing an existing value", () => {
    const root = fixture();
    localGenerator(root, "feature", [
      {
        kind: "json-set",
        path: "registry.json",
        key: "features.{{name | camel}}",
        value: "{{name | pascal}}",
      },
    ]);
    writeJson(join(root, "registry.json"), { features: {} });

    const first = applyGeneratorCommand(root, "feature", { name: "billing" });
    expect(first.status).toBe("passed");
    expect(JSON.parse(readFileSync(join(root, "registry.json"), "utf8"))).toEqual({
      features: { billing: "Billing" },
    });

    const repeat = applyGeneratorCommand(root, "feature", { name: "billing" });
    expect((repeat.data.generation as { result: string }).result).toBe("no-op");

    writeJson(join(root, "registry.json"), { features: { billing: "CustomBilling" } });
    const conflict = applyGeneratorCommand(root, "feature", { name: "billing" });
    expect(conflict.status).toBe("failed");
    expect(JSON.parse(readFileSync(join(root, "registry.json"), "utf8"))).toEqual({
      features: { billing: "CustomBilling" },
    });
  });

  test("applies composed generator templates with their mapped inputs", () => {
    const root = fixture();
    createFileGenerator(root, "leaf");
    localGenerator(
      root,
      "feature",
      [],
      [{ generator: "leaf", inputs: { name: "{{name | pascal}}Part" } }],
    );

    const result = applyGeneratorCommand(root, "feature", { name: "user" });
    expect(result.status).toBe("passed");
    expect(readFileSync(join(root, "UserPart", "user-part.ts"), "utf8")).toBe(
      "export const name = 'UserPart';\n",
    );
  });

  test("rolls back earlier writes when a later write fails", () => {
    const root = fixture();
    createFileGenerator(root);
    const plan = planGenerator(root, "feature", { name: "First" });
    const second = {
      ...plan.operations[0]!,
      path: "Second/second.ts",
      content: "second\n",
    };
    const twoFilePlan = { ...plan, operations: [plan.operations[0]!, second] };
    let writes = 0;

    const result = applyGeneratorPlan(root, twoFilePlan, {
      writeFile(path, content) {
        writes += 1;
        if (writes === 2) throw new Error("injected write failure");
        writeFileSync(path, content);
      },
    });

    expect(result.result).toBe("generation-failed");
    expect(result.rolledBack).toEqual(["First/first.ts"]);
    expect(existsSync(join(root, "First", "first.ts"))).toBe(false);
    expect(existsSync(join(root, "Second", "second.ts"))).toBe(false);
  });

  test("adds a TypeScript barrel export in deterministic order and becomes a no-op", () => {
    const root = fixture();
    localGenerator(root, "feature", [
      {
        kind: "typescript-barrel-export",
        path: "src/data.ts",
        module: "./components/data/{{name | kebab}}",
      },
    ]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "data.ts"),
      '"use client";\n\nexport * from "./components/data/alpha";\nexport * from "./components/data/gamma";\n',
    );

    const first = applyGeneratorCommand(root, "feature", { name: "Beta" });
    expect(first.status).toBe("passed");
    expect((first.data.generation as { result: string }).result).toBe("generated");
    expect(readFileSync(join(root, "src", "data.ts"), "utf8")).toBe(
      '"use client";\n\nexport * from "./components/data/alpha";\nexport * from "./components/data/beta";\nexport * from "./components/data/gamma";\n',
    );

    const repeat = applyGeneratorCommand(root, "feature", { name: "Beta" });
    expect(repeat.status).toBe("passed");
    expect((repeat.data.generation as { result: string }).result).toBe("no-op");
  });

  test("refuses TypeScript barrels that require interpretation", () => {
    const root = fixture();
    localGenerator(root, "feature", [
      {
        kind: "typescript-barrel-export",
        path: "src/data.ts",
        module: "./components/data/{{name | kebab}}",
      },
    ]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "data.ts"), 'import "./setup";\n');

    const result = applyGeneratorCommand(root, "feature", { name: "Beta" });
    expect(result.status).toBe("failed");
    expect((result.data.generation as { result: string }).result).toBe("generation-conflict");
    expect(readFileSync(join(root, "src", "data.ts"), "utf8")).toBe('import "./setup";\n');
  });

  test("rolls back an earlier write when a later barrel write fails", () => {
    const root = fixture();
    localGenerator(root, "feature", [
      {
        kind: "create-file",
        template: "templates/file.tmpl",
        path: "created.ts",
      },
      {
        kind: "typescript-barrel-export",
        path: "src/data.ts",
        module: "./created",
      },
    ]);
    const directory = join(root, ".coding-tooling", "generators", "feature");
    writeFileSync(join(directory, "templates", "file.tmpl"), "export const created = true;\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "data.ts"), 'export * from "./alpha";\n');
    const plan = planGenerator(root, "feature", { name: "Unused" });
    let writes = 0;

    const result = applyGeneratorPlan(root, plan, {
      writeFile(path, content) {
        writes += 1;
        if (writes === 2) throw new Error("injected barrel write failure");
        writeFileSync(path, content);
      },
    });

    expect(result.result).toBe("generation-failed");
    expect(result.rolledBack).toEqual(["created.ts"]);
    expect(existsSync(join(root, "created.ts"))).toBe(false);
    expect(readFileSync(join(root, "src", "data.ts"), "utf8")).toBe('export * from "./alpha";\n');
  });
});
