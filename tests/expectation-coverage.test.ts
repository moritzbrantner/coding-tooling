import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FindingsCoverage } from "../src/expectation-coverage.ts";
import { findingsCommand } from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-coverage-"));
  roots.push(root);
  return root;
}

function coverage(root: string): FindingsCoverage {
  const result = findingsCommand(root);
  return result.data.coverage as FindingsCoverage;
}

function detector(coverage: FindingsCoverage, id: string) {
  const result = coverage.detectors.find((item) => item.id === id);
  expect(result).toBeDefined();
  return result!;
}

describe("findings analysis coverage", () => {
  test("reports TypeScript structural analysis as applied when TypeScript source exists", () => {
    const root = fixture();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      '{"name":"ts-fixture","scripts":{"test":"bun test"}}\n',
    );
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");

    const result = coverage(root);

    expect(result.technologies).toContain("typescript");
    expect(result.unsupportedTechnologies).toEqual([]);
    expect(detector(result, "typescript-source-test")).toMatchObject({
      status: "applied",
      subjects: 1,
    });
  });

  test("distinguishes JavaScript-only repositories from covered clean TypeScript", () => {
    const root = fixture();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      '{"name":"js-fixture","scripts":{"test":"node --test"}}\n',
    );
    writeFileSync(join(root, "src", "index.js"), "export const value = 1;\n");

    const result = coverage(root);

    expect(result.technologies).toEqual(["javascript"]);
    expect(result.unsupportedTechnologies).toEqual(["javascript"]);
    expect(detector(result, "typescript-source-test")).toMatchObject({
      status: "not-applicable",
      subjects: 0,
    });
    expect(detector(result, "source-debt-marker")).toMatchObject({
      status: "applied",
      subjects: 1,
    });
  });

  test("reports Rust as unsupported for structural source-test analysis", () => {
    const root = fixture();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "rust-fixture"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(root, "src", "lib.rs"), "pub fn value() -> u8 { 1 }\n");

    const result = coverage(root);

    expect(result.technologies).toEqual(["rust"]);
    expect(result.unsupportedTechnologies).toEqual(["rust"]);
    expect(detector(result, "typescript-source-test").status).toBe("not-applicable");
    expect(detector(result, "source-unimplemented-stub")).toMatchObject({
      status: "applied",
      subjects: 1,
    });
  });

  test("keeps mixed covered and unsupported technologies explicit", () => {
    const root = fixture();
    mkdirSync(join(root, "web", "src"), { recursive: true });
    mkdirSync(join(root, "engine", "src"), { recursive: true });
    writeFileSync(
      join(root, "web", "package.json"),
      '{"name":"web","scripts":{"test":"bun test"}}\n',
    );
    writeFileSync(join(root, "web", "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "web", "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(
      join(root, "engine", "Cargo.toml"),
      '[package]\nname = "engine"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(root, "engine", "src", "lib.rs"), "pub fn value() -> u8 { 1 }\n");

    const result = coverage(root);

    expect(result.technologies).toEqual(["javascript", "rust", "typescript"]);
    expect(result.unsupportedTechnologies).toEqual(["rust"]);
    expect(detector(result, "typescript-source-test")).toMatchObject({
      status: "applied",
      subjects: 1,
    });
    expect(detector(result, "source-debt-marker")).toMatchObject({
      status: "applied",
      subjects: 2,
    });
  });

  test("every registered detector has an explicit coverage rule", () => {
    const root = fixture();
    const result = coverage(root);

    expect(result.detectors.every((item) => item.status !== "unavailable")).toBeTrue();
  });
});
