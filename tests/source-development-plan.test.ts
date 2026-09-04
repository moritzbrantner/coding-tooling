import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planChecks } from "../src/core.ts";

function rustRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-source-plan-"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  return root;
}

test("keeps Cargo lock enforcement in distribution validation", () => {
  const root = rustRepository();
  try {
    const plan = planChecks({ root, tier: "full" });
    const commands = Object.fromEntries(
      plan.checks.map((check) => [check.capability, check.command]),
    );

    expect(plan.dependencyResolution).toBe("distribution");
    expect(commands.build).toContain("--locked");
    expect(commands["test:unit"]).toContain("--locked");
    expect(commands["test:integration"]).toContain("--locked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows Cargo to resolve the exact path-patched source graph only in source development", () => {
  const root = rustRepository();
  try {
    const plan = planChecks({ root, tier: "full", dependencyResolution: "source-development" });
    const commands = Object.fromEntries(
      plan.checks.map((check) => [check.capability, check.command]),
    );

    expect(plan.dependencyResolution).toBe("source-development");
    expect(commands.build).not.toContain("--locked");
    expect(commands["test:unit"]).not.toContain("--locked");
    expect(commands["test:integration"]).not.toContain("--locked");
    expect(commands["format:check"]).toEqual(["cargo", "fmt", "--check"]);
    expect(commands.lint).toEqual([
      "cargo",
      "clippy",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
