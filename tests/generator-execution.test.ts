import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeGeneratorCommand } from "../src/generator-execution.ts";
import {
  evaluateGeneratorPrerequisites,
  type CapabilityChecker,
} from "../src/generator-verification.ts";
import { planGenerator } from "../src/generators.ts";
import type { Capability, ResultEnvelope } from "../src/model.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-generator-execution-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function toolingFixture(root: string, dependencies: Record<string, string> = {}): void {
  writeJson(join(root, "package.json"), {
    name: "generator-dogfood",
    private: true,
    dependencies,
    scripts: {
      "format:check": "oxfmt --check src",
      lint: "oxlint src",
      typecheck: "tsc --noEmit",
    },
  });
  writeFileSync(join(root, "bun.lock"), "");
  writeJson(join(root, "tsconfig.json"), {
    compilerOptions: {
      strict: true,
      jsx: "preserve",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts", "src/**/*.tsx", "react.d.ts"],
  });
  writeFileSync(
    join(root, "react.d.ts"),
    [
      'declare module "react" {',
      "  export type ReactNode = unknown;",
      "}",
      "",
      "declare namespace JSX {",
      "  interface IntrinsicElements {",
      "    div: { children?: unknown };",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
}

function installedReactGenerator(root: string): void {
  const directory = join(
    root,
    ".conventions",
    "modules",
    "react",
    "technologies",
    "typescript",
    "react",
    "generators",
    "react-component",
  );
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeJson(join(directory, "generator.json"), {
    schemaVersion: 1,
    id: "react-component",
    description: "Create a colocated React component scaffold with an explicit local entry point.",
    rules: ["REACT-001", "REACT-006"],
    technologies: ["typescript", "react"],
    inputs: { name: { type: "identifier", required: true } },
    target: { kind: "concept", concept: "component-root" },
    operations: [
      {
        kind: "create-file",
        template: "templates/Component.tsx.tmpl",
        path: "{{name | pascal}}/{{name | pascal}}.tsx",
      },
      {
        kind: "create-file",
        template: "templates/index.ts.tmpl",
        path: "{{name | pascal}}/index.ts",
      },
    ],
    compose: [],
    prerequisites: [{ kind: "package", name: "react" }],
    postconditions: ["format:check", "lint", "typecheck"],
  });
  writeFileSync(
    join(directory, "templates", "Component.tsx.tmpl"),
    [
      'import type { ReactNode } from "react";',
      "",
      "export type {{name | pascal}}Props = {",
      "  children?: ReactNode;",
      "};",
      "",
      "export function {{name | pascal}}({ children }: {{name | pascal}}Props) {",
      "  return <div>{children}</div>;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "templates", "index.ts.tmpl"),
    [
      'export { {{name | pascal}} } from "./{{name | pascal}}";',
      'export type { {{name | pascal}}Props } from "./{{name | pascal}}";',
      "",
    ].join("\n"),
  );
  writeJson(join(root, ".coding-tooling.json"), {
    schemaVersion: 1,
    generatorTargets: { "component-root": "src/components" },
  });
}

function localFeatureGenerator(root: string): void {
  const directory = join(root, ".coding-tooling", "generators", "feature");
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeJson(join(directory, "generator.json"), {
    schemaVersion: 1,
    id: "feature",
    description: "Create the repository-local feature structure.",
    rules: [],
    technologies: ["typescript"],
    inputs: { name: { type: "identifier", required: true } },
    target: { kind: "root" },
    operations: [
      {
        kind: "create-file",
        template: "templates/feature.ts.tmpl",
        path: "src/features/{{name | kebab}}/{{name | pascal}}.ts",
      },
      {
        kind: "create-file",
        template: "templates/index.ts.tmpl",
        path: "src/features/{{name | kebab}}/index.ts",
      },
    ],
    compose: [],
    prerequisites: [],
    postconditions: ["typecheck"],
  });
  writeFileSync(
    join(directory, "templates", "feature.ts.tmpl"),
    'export const {{name | camel}}Feature = "{{name | kebab}}";\n',
  );
  writeFileSync(
    join(directory, "templates", "index.ts.tmpl"),
    'export { {{name | camel}}Feature } from "./{{name | pascal}}";\n',
  );
}

function capabilityResult(
  capability: Capability,
  status: ResultEnvelope<Record<string, unknown>>["status"],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "check",
    status,
    durationMs: 1,
    data: { capability, results: [] },
    diagnostics:
      status === "passed"
        ? []
        : [{ code: "fixture-failure", message: `${capability} failed intentionally` }],
  };
}

describe("shared generator dogfood", () => {
  test("runs the installed React generator through real offline postconditions", () => {
    const root = fixture();
    toolingFixture(root, { react: "19.1.0" });
    installedReactGenerator(root);

    const first = executeGeneratorCommand(root, "react-component", { name: "UserCard" });
    expect(first.status).toBe("passed");
    expect(first.data.result).toBe("generated-and-verified");
    expect((first.data.postconditions as { checks: unknown[] }).checks).toHaveLength(3);
    expect(readFileSync(join(root, "src/components/UserCard/UserCard.tsx"), "utf8")).toContain(
      "export function UserCard",
    );

    const repeat = executeGeneratorCommand(root, "react-component", { name: "UserCard" });
    expect(repeat.status).toBe("passed");
    expect((repeat.data.generation as { result: string }).result).toBe("no-op");
    expect(repeat.data.result).toBe("generated-and-verified");
  });

  test("preserves generated React files when a postcondition fails", () => {
    const root = fixture();
    toolingFixture(root, { react: "19.1.0" });
    installedReactGenerator(root);
    const seen: Capability[] = [];
    const checker: CapabilityChecker = (_root, capability) => {
      seen.push(capability);
      return capabilityResult(capability, capability === "lint" ? "failed" : "passed");
    };

    const result = executeGeneratorCommand(
      root,
      "react-component",
      { name: "FailureCard" },
      undefined,
      { checkCapability: checker },
    );

    expect(result.status).toBe("failed");
    expect(result.data.result).toBe("generated-but-unverified");
    expect(seen).toEqual(["format:check", "lint"]);
    expect(existsSync(join(root, "src/components/FailureCard/FailureCard.tsx"))).toBe(true);
  });

  test("refuses to overwrite a user edit after initial generation", () => {
    const root = fixture();
    toolingFixture(root, { react: "19.1.0" });
    installedReactGenerator(root);
    expect(executeGeneratorCommand(root, "react-component", { name: "UserCard" }).status).toBe(
      "passed",
    );
    const component = join(root, "src/components/UserCard/UserCard.tsx");
    writeFileSync(component, "export function UserCard() { return null; }\n");

    const result = executeGeneratorCommand(root, "react-component", { name: "UserCard" });
    expect(result.status).toBe("failed");
    expect(result.data.result).toBe("generation-conflict");
    expect(readFileSync(component, "utf8")).toBe("export function UserCard() { return null; }\n");
  });
});

describe("repository-local generator dogfood", () => {
  test("uses the same execution path for a local multi-file feature scaffold", () => {
    const root = fixture();
    toolingFixture(root);
    localFeatureGenerator(root);

    const first = executeGeneratorCommand(root, "feature", { name: "Billing" });
    expect(first.status).toBe("passed");
    expect(first.data.result).toBe("generated-and-verified");
    expect(readFileSync(join(root, "src/features/billing/Billing.ts"), "utf8")).toBe(
      'export const billingFeature = "billing";\n',
    );

    const repeat = executeGeneratorCommand(root, "feature", { name: "Billing" });
    expect((repeat.data.generation as { result: string }).result).toBe("no-op");

    const file = join(root, "src/features/billing/Billing.ts");
    writeFileSync(file, 'export const billingFeature = "custom";\n');
    const conflict = executeGeneratorCommand(root, "feature", { name: "Billing" });
    expect(conflict.status).toBe("failed");
    expect(conflict.data.result).toBe("generation-conflict");
    expect(readFileSync(file, "utf8")).toContain("custom");
  });

  test("keeps a local scaffold after injected postcondition failure", () => {
    const root = fixture();
    toolingFixture(root);
    localFeatureGenerator(root);
    const checker: CapabilityChecker = (_root, capability) =>
      capabilityResult(capability, "failed");

    const result = executeGeneratorCommand(root, "feature", { name: "Orders" }, undefined, {
      checkCapability: checker,
    });
    expect(result.status).toBe("failed");
    expect(result.data.result).toBe("generated-but-unverified");
    expect(existsSync(join(root, "src/features/orders/Orders.ts"))).toBe(true);
  });
});

describe("generator prerequisites", () => {
  test("blocks missing packages before mutation and reports that network would be required", () => {
    const root = fixture();
    toolingFixture(root);
    installedReactGenerator(root);

    const result = executeGeneratorCommand(root, "react-component", { name: "BlockedCard" });
    expect(result.status).toBe("failed");
    expect(result.data.result).toBe("prerequisite-failed");
    expect(result.diagnostics[0]?.code).toBe("network-required");
    expect(existsSync(join(root, "src/components/BlockedCard"))).toBe(false);
  });

  test("checks convention modules and explicit network seams from local state", () => {
    const root = fixture();
    toolingFixture(root);
    localFeatureGenerator(root);
    const plan = planGenerator(root, "feature", { name: "Billing" });
    plan.prerequisites = [
      { kind: "convention-module", name: "typescript" },
      { kind: "network", reason: "future adapter" },
    ];
    writeJson(join(root, "conventions.lock.json"), {
      schemaVersion: 1,
      resolvedModules: ["base", "typescript"],
    });

    const evaluation = evaluateGeneratorPrerequisites(root, plan);
    expect(evaluation.status).toBe("failed");
    expect(evaluation.checks.map(({ status, code }) => ({ status, code }))).toEqual([
      { status: "passed", code: undefined },
      { status: "failed", code: "network-required" },
    ]);
  });
});
