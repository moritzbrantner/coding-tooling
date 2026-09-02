import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDetectorContext } from "../src/expectation-package-context.ts";
import { missingTestFindings } from "../src/expectation-test-detector.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-test-reachability-"));
  roots.push(root);
  mkdirSync(join(root, "src", "test"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "public.ts"), 'export { helper } from "./helper.js";\n');
  writeFileSync(join(root, "src", "helper.ts"), 'export const helper = "covered";\n');
  writeFileSync(join(root, "src", "orphan.ts"), 'export const orphan = "missing";\n');
  writeFileSync(join(root, "src", "widget.stories.tsx"), "export const Story = {};\n");
  writeFileSync(join(root, "src", "test", "fixture.ts"), "export const fixture = true;\n");
  writeFileSync(
    join(root, "src", "public.test.ts"),
    'import { helper } from "./public";\nvoid helper;\n',
  );
  return root;
}

describe("TypeScript test reachability", () => {
  test("accepts production source reached transitively from a test", () => {
    const findings = missingTestFindings(createDetectorContext(fixture()));

    expect(findings.map((finding) => finding.subject.key)).toEqual(["src/orphan.ts"]);
    expect(findings[0]?.requirement.description).toBe(
      "deterministic structural test reachability",
    );
  });

  test("does not classify stories or test fixtures as production source", () => {
    const context = createDetectorContext(fixture());
    const sourcePaths = context.packages[0]!.sourceFiles.map((path) =>
      path.replaceAll("\\", "/"),
    );

    expect(sourcePaths.some((path) => path.endsWith("/src/widget.stories.tsx"))).toBeFalse();
    expect(sourcePaths.some((path) => path.endsWith("/src/test/fixture.ts"))).toBeFalse();
  });
});
