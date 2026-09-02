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

import { applyGeneratorPlan } from "../src/generator-apply.ts";
import type { GeneratorPlan } from "../src/generators.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function createFilePlan(path: string): GeneratorPlan {
  return {
    generator: "fixture",
    inputs: {},
    target: ".",
    operations: [
      {
        generator: "fixture",
        kind: "create-file",
        template: "fixture",
        path,
        content: "generated\n",
      },
    ],
    prerequisites: [],
    postconditions: [],
  };
}

describe("generator symlink safety", () => {
  test("rejects a symlinked parent before creating a file", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory("coding-tooling-generator-root-");
    const outside = temporaryDirectory("coding-tooling-generator-outside-");
    symlinkSync(outside, join(root, "tests"), "dir");

    const result = applyGeneratorPlan(root, createFilePlan("tests/generated.ts"));

    expect(result.result).toBe("generation-conflict");
    expect(existsSync(join(outside, "generated.ts"))).toBeFalse();
  });

  test("rejects a symlinked structured-update target", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory("coding-tooling-generator-root-");
    const outside = temporaryDirectory("coding-tooling-generator-outside-");
    const outsideConfig = join(outside, "config.json");
    writeFileSync(outsideConfig, "{}\n");
    symlinkSync(outsideConfig, join(root, "config.json"), "file");
    const before = readFileSync(outsideConfig, "utf8");
    const plan: GeneratorPlan = {
      generator: "fixture",
      inputs: {},
      target: ".",
      operations: [
        {
          generator: "fixture",
          kind: "json-set",
          path: "config.json",
          key: "enabled",
          value: "true",
        },
      ],
      prerequisites: [],
      postconditions: [],
    };

    const result = applyGeneratorPlan(root, plan);

    expect(result.result).toBe("generation-conflict");
    expect(readFileSync(outsideConfig, "utf8")).toBe(before);
  });

  test("still creates files through ordinary directories", () => {
    const root = temporaryDirectory("coding-tooling-generator-root-");
    mkdirSync(join(root, "tests"), { recursive: true });

    const result = applyGeneratorPlan(root, createFilePlan("tests/generated.ts"));

    expect(result.result).toBe("generated");
    expect(readFileSync(join(root, "tests", "generated.ts"), "utf8")).toBe("generated\n");
  });
});
