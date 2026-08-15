import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Capability = {
  name: string;
  kind: string;
  tier: string;
  scriptCandidates: string[];
  defaultArtifacts: string[];
  optIn: boolean;
  baselineRequired: boolean;
};

type Catalog = {
  schemaVersion: number;
  capabilities: Capability[];
};

const catalog = JSON.parse(
  readFileSync(new URL("../capabilities/catalog.json", import.meta.url), "utf8"),
) as Catalog;

describe("capability catalog", () => {
  test("uses a stable schema version and unique semantic names", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.capabilities.length).toBeGreaterThan(0);

    const names = catalog.capabilities.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("declares deterministic script candidates and valid tiers", () => {
    const tiers = new Set(["fast", "focused", "integration", "system", "performance"]);

    for (const capability of catalog.capabilities) {
      expect(capability.scriptCandidates.length).toBeGreaterThan(0);
      expect(new Set(capability.scriptCandidates).size).toBe(capability.scriptCandidates.length);
      expect(tiers.has(capability.tier)).toBe(true);
    }
  });

  test("keeps cross-candidate benchmark comparison outside tooling", () => {
    const byName = new Map(catalog.capabilities.map((capability) => [capability.name, capability]));

    expect(byName.get("audit:lighthouse")?.baselineRequired).toBe(true);
    expect(byName.get("benchmark")?.baselineRequired).toBe(false);
    expect(byName.has("benchmark:compare")).toBe(false);
  });
});
