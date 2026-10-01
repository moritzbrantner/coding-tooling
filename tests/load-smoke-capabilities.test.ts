import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repositoryFoundationRecommendation } from "../src/bootstrap.ts";
import { check, discoverComponents, runPlan } from "../src/core.ts";

const roots: string[] = [];
function repository(command?: string[], scripts: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "load-smoke-capabilities-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "service", scripts }));
  writeFileSync(
    join(root, ".coding-tooling.json"),
    JSON.stringify({
      schemaVersion: 1,
      optionalCapabilities: ["load:smoke"],
      tiers: { performance: ["load:smoke"] },
      capabilityCommands: command ? { ".": { "load:smoke": command } } : {},
    }),
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bounded load smoke invocation", () => {
  test("discovers only the declared load script and keeps it separate from E2E and benchmarks", () => {
    const root = repository(undefined, {
      "load:smoke": "runtime-profiler capture --scenario fixture.json --output evidence",
      "test:e2e": "correctness-suite",
      benchmark: "benchmark-suite",
    });
    const component = discoverComponents(root)[0];
    expect(component?.capabilities["load:smoke"]).toEqual(["npm", "run", "load:smoke"]);
    const recommendation = repositoryFoundationRecommendation(root).config;
    expect(recommendation.tiers?.performance).toEqual(["benchmark", "load:smoke"]);
    expect(recommendation.requiredCapabilities).not.toContain("load:smoke");
    const absent = repository(undefined, { "test:e2e": "correctness-suite", bench: "bench" });
    expect(discoverComponents(absent)[0]?.capabilities["load:smoke"]).toBeUndefined();
  });

  test("invokes the owner command and preserves its distinct unavailable status", () => {
    for (const [exitCode, status] of [
      [0, "passed"],
      [1, "failed"],
      [2, "unavailable"],
      [3, "failed"],
    ] as const) {
      const root = repository([process.execPath, "-e", `process.exit(${exitCode})`]);
      expect(check(root, "load:smoke").status).toBe(status);
      expect(runPlan({ root, tier: "performance", strict: true }).status).toBe(status);
    }
  });

  test("a missing declared profiler executable is unavailable in checks and tiers", () => {
    const root = repository(["./runtime-profiler-uninstalled"]);
    expect(check(root, "load:smoke").status).toBe("unavailable");
    expect(runPlan({ root, tier: "performance", strict: true }).status).toBe("unavailable");
  });

  test("an explicitly selected missing optional workload cannot make performance green", () => {
    const root = repository();
    expect(check(root, "load:smoke").status).toBe("unavailable");
    expect(runPlan({ root, tier: "performance", strict: true }).status).toBe("unavailable");
  });

  test("load's reserved unavailable exit code does not reinterpret ordinary validation commands", () => {
    const root = repository();
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        capabilityCommands: { ".": { lint: [process.execPath, "-e", "process.exit(2)"] } },
      }),
    );
    expect(check(root, "lint").status).toBe("failed");
  });
});
