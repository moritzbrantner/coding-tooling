import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeRepository,
  planNormalization,
  type Normalizer,
} from "../src/normalization.ts";
import type { CommandResult } from "../src/shared.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(prefix = "coding-tooling-normalization-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageFixture(): string {
  const root = fixture();
  writeJson(join(root, "package.json"), {
    name: "fixture",
    scripts: {
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt .",
      lint: "oxlint .",
      "lint:fix": "oxlint --fix .",
    },
  });
  writeFileSync(join(root, "bun.lock"), "");
  return root;
}

function success(normalizer: Normalizer): CommandResult {
  return {
    command: normalizer.command,
    status: 0,
    stdout: "",
    stderr: "",
  };
}

test("plans safe package lint fixes before formatter writes", () => {
  const root = packageFixture();

  const plan = planNormalization(root);

  expect(plan.unsupported).toEqual([]);
  expect(plan.normalizers.map((item) => [item.capability, item.tool, item.command])).toEqual([
    ["lint", "oxlint", ["bun", "run", "lint:fix"]],
    ["format:check", "oxfmt", ["bun", "run", "format:write"]],
  ]);
});

test("uses cargo fmt as a deterministic formatter but does not invent a clippy fixer", () => {
  const root = fixture();
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "fixture"\nversion = "0.1.0"\n',
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "lib.rs"), "pub fn value()->u8{1}\n");

  const plan = planNormalization(root);

  expect(plan.normalizers).toEqual([
    expect.objectContaining({
      capability: "format:check",
      tool: "cargo-fmt",
      command: ["cargo", "fmt"],
    }),
  ]);
  expect(plan.unsupported).toEqual([
    expect.objectContaining({ capability: "lint", command: ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"] }),
  ]);
});

test("accepts normalization only after a second pass is a content no-op", () => {
  const root = packageFixture();
  mkdirSync(join(root, "src"), { recursive: true });
  const source = join(root, "src", "value.ts");
  writeFileSync(source, "export const value=1\n");
  let executions = 0;

  const result = normalizeRepository(root, {
    execute: (_root, normalizer) => {
      executions += 1;
      if (executions === 1) writeFileSync(source, "export const value = 1;\n");
      return success(normalizer);
    },
  });

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "normalized",
    coverage: "complete",
    changed: true,
    idempotent: true,
  });
  expect(result.data.passes).toHaveLength(2);
  expect(executions).toBe(4);
  expect(readFileSync(source, "utf8")).toBe("export const value = 1;\n");
});

test("fails closed when the second normalization pass changes content again", () => {
  const root = fixture();
  writeJson(join(root, "package.json"), {
    name: "fixture",
    scripts: {
      "format:check": "oxfmt --check .",
      "format:write": "oxfmt .",
    },
  });
  writeFileSync(join(root, "bun.lock"), "");
  mkdirSync(join(root, "src"), { recursive: true });
  const source = join(root, "src", "value.ts");
  writeFileSync(source, "A\n");
  let executions = 0;

  const result = normalizeRepository(root, {
    execute: (_root, normalizer) => {
      executions += 1;
      writeFileSync(source, executions % 2 === 1 ? "B\n" : "A\n");
      return success(normalizer);
    },
  });

  expect(result.status).toBe("failed");
  expect(result.data).toMatchObject({ result: "blocked", idempotent: false });
  expect(result.diagnostics[0]?.code).toBe("normalization-not-idempotent");
});

test("fails closed when a known normalization command fails", () => {
  const root = packageFixture();

  const result = normalizeRepository(root, {
    execute: (_root, normalizer) => ({
      command: normalizer.command,
      status: 1,
      stdout: "",
      stderr: "formatter failed",
    }),
  });

  expect(result.status).toBe("failed");
  expect(result.data).toMatchObject({ result: "blocked", idempotent: false });
  expect(result.diagnostics[0]?.code).toBe("normalization-command-failed");
});

test("reports unsafe or unknown mutation surfaces without executing guessed fixes", () => {
  const root = fixture();
  writeJson(join(root, "package.json"), {
    name: "fixture",
    scripts: {
      "format:check": "prettier --check .",
      lint: "eslint .",
    },
  });
  writeFileSync(join(root, "bun.lock"), "");

  const result = normalizeRepository(root);

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "no-op",
    coverage: "unsupported",
    changed: false,
    idempotent: true,
  });
  expect(result.data.unsupported).toHaveLength(2);
});
