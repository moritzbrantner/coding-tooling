import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generatorCatalog, generatorCommand, planGenerator } from "../src/generators.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-generators-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function descriptor(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    description: `${id} fixture`,
    rules: [],
    technologies: ["typescript"],
    inputs: {
      name: { type: "identifier", required: true },
    },
    target: { kind: "root" },
    operations: [
      {
        kind: "create-file",
        template: "templates/file.tmpl",
        path: "{{name | pascal}}/{{name | kebab}}.ts",
      },
    ],
    compose: [],
    prerequisites: [],
    postconditions: ["typecheck"],
    ...overrides,
  };
}

function localGenerator(root: string, id: string, value = descriptor(id)): void {
  const directory = join(root, ".coding-tooling", "generators", id);
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeJson(join(directory, "generator.json"), value);
  writeFileSync(join(directory, "templates", "file.tmpl"), "export const value = '{{name}}';\n");
}

function conventionGenerator(root: string, id: string): void {
  const directory = join(
    root,
    ".conventions",
    "modules",
    "react",
    "technologies",
    "typescript",
    "react",
    "generators",
    id,
  );
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeJson(join(directory, "generator.json"), descriptor(id));
  writeFileSync(join(directory, "templates", "file.tmpl"), "export const value = '{{name}}';\n");
}

describe("generator catalog", () => {
  test("discovers installed convention and repository-local generators together", () => {
    const root = fixture();
    conventionGenerator(root, "react-component");
    localGenerator(root, "feature");

    expect(
      generatorCatalog(root).map(({ id, source, module }) => ({ id, source, module })),
    ).toEqual([
      { id: "feature", source: "local", module: undefined },
      { id: "react-component", source: "convention", module: "react" },
    ]);
  });

  test("rejects collisions instead of giving local generators precedence", () => {
    const root = fixture();
    conventionGenerator(root, "feature");
    localGenerator(root, "feature");

    const result = generatorCommand(root, "list");
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("generator-id-conflict");
  });

  test("rejects composition cycles", () => {
    const root = fixture();
    localGenerator(
      root,
      "one",
      descriptor("one", { compose: [{ generator: "two", inputs: { name: "{{name}}" } }] }),
    );
    localGenerator(
      root,
      "two",
      descriptor("two", { compose: [{ generator: "one", inputs: { name: "{{name}}" } }] }),
    );

    const result = generatorCommand(root, "list");
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("generator-composition-cycle");
  });
});

describe("generator planning", () => {
  test("validates typed inputs and produces a stable zero-write plan", () => {
    const root = fixture();
    localGenerator(root, "feature");

    const plan = planGenerator(root, "feature", { name: "UserProfile" });
    expect(plan).toEqual({
      generator: "feature",
      inputs: { name: "UserProfile" },
      target: ".",
      operations: [
        {
          generator: "feature",
          kind: "create-file",
          path: "UserProfile/user-profile.ts",
          template: ".coding-tooling/generators/feature/templates/file.tmpl",
          content: "export const value = 'UserProfile';\n",
        },
      ],
      prerequisites: [],
      postconditions: ["typecheck"],
    });
  });

  test("returns target-required rather than guessing among configured targets", () => {
    const root = fixture();
    localGenerator(
      root,
      "feature",
      descriptor("feature", { target: { kind: "concept", concept: "component-root" } }),
    );
    writeJson(join(root, ".coding-tooling.json"), {
      schemaVersion: 1,
      generatorTargets: { "component-root": ["src/a", "src/b"] },
    });

    const result = generatorCommand(root, "plan", "feature", { name: "Card" });
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("target-required");
  });

  test("uses an explicit target without heuristic path selection", () => {
    const root = fixture();
    localGenerator(
      root,
      "feature",
      descriptor("feature", { target: { kind: "concept", concept: "component-root" } }),
    );

    const plan = planGenerator(root, "feature", { name: "Card" }, "src/components");
    expect(plan.target).toBe("src/components");
    expect(plan.operations[0]?.path).toBe("src/components/Card/card.ts");
  });

  test("rejects unknown and invalid input values before planning", () => {
    const root = fixture();
    localGenerator(root, "feature");

    expect(
      generatorCommand(root, "plan", "feature", { name: "../escape" }).diagnostics[0]?.code,
    ).toBe("invalid-generator-input");
    expect(
      generatorCommand(root, "plan", "feature", { name: "Card", extra: "x" }).diagnostics[0]?.code,
    ).toBe("unknown-generator-input");
  });

  test("flattens explicitly mapped acyclic composition deterministically", () => {
    const root = fixture();
    localGenerator(root, "leaf");
    localGenerator(
      root,
      "feature",
      descriptor("feature", {
        operations: [],
        compose: [{ generator: "leaf", inputs: { name: "{{name | pascal}}Part" } }],
      }),
    );

    const plan = planGenerator(root, "feature", { name: "user" });
    expect(plan.operations.map((operation) => operation.path)).toEqual(["UserPart/user-part.ts"]);
  });

  test("selects a declared template through boolean interpolation and humanizes titles", () => {
    const root = fixture();
    const value = descriptor("feature", {
      inputs: {
        name: { type: "identifier", required: true },
        client: { type: "boolean", required: true },
      },
      operations: [
        {
          kind: "create-file",
          template: "templates/component-{{client}}.tmpl",
          path: "{{name | kebab}}.tsx",
        },
      ],
    });
    localGenerator(root, "feature", value);
    const directory = join(root, ".coding-tooling", "generators", "feature", "templates");
    writeFileSync(
      join(directory, "component-true.tmpl"),
      '"use client";\nexport const title = "{{name | title}}";\n',
    );
    writeFileSync(
      join(directory, "component-false.tmpl"),
      'export const title = "{{name | title}}";\n',
    );

    const client = planGenerator(root, "feature", { name: "StatusBadge", client: "true" });
    expect(client.operations[0]).toMatchObject({
      template: ".coding-tooling/generators/feature/templates/component-true.tmpl",
      content: '"use client";\nexport const title = "Status Badge";\n',
    });

    const server = planGenerator(root, "feature", { name: "status-badge", client: "false" });
    expect(server.operations[0]).toMatchObject({
      template: ".coding-tooling/generators/feature/templates/component-false.tmpl",
      content: 'export const title = "Status Badge";\n',
    });
  });

  test("rejects unmanaged file prerequisite paths", () => {
    const root = fixture();
    localGenerator(
      root,
      "feature",
      descriptor("feature", { prerequisites: [{ kind: "file", path: "../outside.ts" }] }),
    );
    const result = generatorCommand(root, "list");
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("invalid-generator");
  });
});
