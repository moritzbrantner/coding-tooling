import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { repositoryFoundationRecommendation } from "../src/bootstrap.ts";
import { discoverComponents } from "../src/core.ts";

function makePackage(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-profiling-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "profiled-package", scripts }, null, 2)}\n`,
  );
  return root;
}

describe("profiling capabilities", () => {
  test("discovers only explicitly declared package profiling scripts", () => {
    const root = makePackage({
      "profile:runtime": "runtime-profiler capture --scenario runtime.json --output out",
      "profile:hotspots": "runtime-profiler capture --scenario hotspots.json --output out",
      "profile:memory": "runtime-profiler capture --scenario memory.json --output out",
    });

    const [component] = discoverComponents(root);

    expect(component?.capabilities["profile:runtime"]).toEqual(["npm", "run", "profile:runtime"]);
    expect(component?.capabilities["profile:hotspots"]).toEqual(["npm", "run", "profile:hotspots"]);
    expect(component?.capabilities["profile:memory"]).toEqual(["npm", "run", "profile:memory"]);
  });

  test("puts declared profiler capabilities into optional performance tiers", () => {
    const root = makePackage({
      "format:check": "true",
      lint: "true",
      build: "true",
      test: "true",
      "profile:runtime": "true",
      "profile:hotspots": "true",
    });

    const recommendation = repositoryFoundationRecommendation(root);

    expect(recommendation.config.optionalCapabilities).toEqual(
      expect.arrayContaining(["profile:runtime", "profile:hotspots"]),
    );
    expect(recommendation.config.tiers?.performance).toEqual([
      "profile:runtime",
      "profile:hotspots",
    ]);
    expect(recommendation.config.requiredCapabilities).not.toContain("profile:runtime");
    expect(recommendation.config.requiredCapabilities).not.toContain("profile:hotspots");
  });

  test("does not infer profiler support from repository ecosystem alone", () => {
    const root = makePackage({
      "format:check": "true",
      lint: "true",
      build: "true",
      test: "true",
    });
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "profiling-test"\nversion = "0.1.0"\n',
    );

    const recommendation = repositoryFoundationRecommendation(root);

    expect(recommendation.config.optionalCapabilities).not.toContain("profile:runtime");
    expect(recommendation.config.optionalCapabilities).not.toContain("profile:hotspots");
    expect(recommendation.config.optionalCapabilities).not.toContain("profile:memory");
  });
});
