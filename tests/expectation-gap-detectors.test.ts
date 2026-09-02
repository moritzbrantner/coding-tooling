import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations } from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(scripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-gaps-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts }, null, 2)}\n`,
  );
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  return root;
}

function expectationIds(root: string): string[] {
  return analyzeExpectations(root).findings.map((finding) => finding.expectationId);
}

describe("repository gap detectors", () => {
  test("reports packages with production TypeScript source but no test capability", () => {
    const root = fixture({ lint: "oxlint ." });
    writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

    const finding = analyzeExpectations(root).findings.find(
      (item) => item.expectationId === "package-test-capability",
    );

    expect(finding?.subject.key).toBe(".");
    expect(finding?.requirement.key).toBe("test-capability");
  });

  test("does not report the package test capability when test:unit is declared", () => {
    const root = fixture({ "test:unit": "bun test" });
    writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

    expect(expectationIds(root)).not.toContain("package-test-capability");
  });

  test("reports TODO/FIXME markers as informational production debt", () => {
    const root = fixture({ test: "bun test" });
    writeFileSync(
      join(root, "src", "service.ts"),
      "// TODO: replace temporary branch\nexport const service = true;\n",
    );

    const finding = analyzeExpectations(root).findings.find(
      (item) => item.expectationId === "source-debt-marker",
    );

    expect(finding?.severity).toBe("info");
    expect(finding?.subject.key).toBe("src/service.ts");
  });

  test("ignores TODO markers in tests", () => {
    const root = fixture({ test: "bun test" });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
    writeFileSync(join(root, "tests", "service.test.ts"), "// TODO: improve this fixture\n");

    expect(expectationIds(root)).not.toContain("source-debt-marker");
  });

  test("reports explicit runtime stubs across supported source languages", () => {
    const root = fixture({ test: "bun test" });
    mkdirSync(join(root, "native", "src"), { recursive: true });
    writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
    writeFileSync(join(root, "native", "src", "lib.rs"), "pub fn run() { todo!() }\n");

    const finding = analyzeExpectations(root).findings.find(
      (item) => item.expectationId === "source-unimplemented-stub",
    );

    expect(finding?.subject.key).toBe("native/src/lib.rs");
    expect(finding?.severity).toBe("warning");
  });

  test("accepts an existing benchmark runner referenced by the declared script", () => {
    const root = fixture({ test: "bun test", bench: "bun scripts/run-benchmarks.ts" });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "run-benchmarks.ts"), "export {};\n");

    expect(expectationIds(root)).not.toContain("benchmark-evidence");
  });

  test("requires benchmark evidence only after a benchmark capability is declared", () => {
    const root = fixture({ test: "bun test", benchmark: "bun run scripts/perf.ts" });
    writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

    expect(expectationIds(root)).toContain("benchmark-evidence");

    mkdirSync(join(root, "benchmarks"), { recursive: true });
    writeFileSync(join(root, "benchmarks", "service.bench.ts"), "export {};\n");

    expect(expectationIds(root)).not.toContain("benchmark-evidence");
  });
});
