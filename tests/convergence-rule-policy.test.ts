import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeGeneratorCommand } from "../src/generator-execution.ts";

const roots: string[] = [];

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-rule-policy-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"rule-policy-fixture"}\n');
  return root;
}

function generator(
  root: string,
  id: string,
  output: string,
  compose: Array<{ generator: string; inputs?: Record<string, string> }> = [],
): void {
  const directory = join(root, ".coding-tooling", "generators", id);
  mkdirSync(join(directory, "templates"), { recursive: true });
  writeFileSync(join(directory, "templates", "value.tmpl"), `export const ${id} = true;\n`);
  writeFileSync(
    join(directory, "generator.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      description: `Generate ${id}.`,
      rules: [],
      technologies: ["typescript"],
      inputs: {},
      target: { kind: "root" },
      operations: [{ kind: "create-file", template: "templates/value.tmpl", path: output }],
      compose,
      prerequisites: [],
      postconditions: [],
    })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a composed generator keeps its own independently configurable rule", () => {
  const root = rootFixture();
  generator(root, "child", "child.ts");
  generator(root, "parent", "parent.ts", [{ generator: "child" }]);
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      convergence: { rules: { "generator.child": "disabled" } },
    })}\n`,
  );

  const result = executeGeneratorCommand(root, "parent", {});

  expect(result.status).toBe("unavailable");
  expect(result.data).toMatchObject({
    result: "rule-withheld",
    rules: [
      { id: "generator.child", mode: "disabled" },
      { id: "generator.parent", mode: "apply" },
    ],
    withheldRules: [{ id: "generator.child", mode: "disabled" }],
  });
  expect(existsSync(join(root, "parent.ts"))).toBeFalse();
  expect(existsSync(join(root, "child.ts"))).toBeFalse();
});

test("an unreadable convergence policy fails closed before generator mutation", () => {
  const root = rootFixture();
  generator(root, "sample", "generated.ts");
  writeFileSync(join(root, ".coding-tooling.json"), "{\n");

  const result = executeGeneratorCommand(root, "sample", {});

  expect(result.status).toBe("error");
  expect(result.data).toMatchObject({ result: "invalid-convergence-rule-policy" });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "invalid-convergence-rule-policy" }),
  );
  expect(existsSync(join(root, "generated.ts"))).toBeFalse();
});
