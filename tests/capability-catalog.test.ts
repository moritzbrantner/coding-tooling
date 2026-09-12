import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverComponents } from "../src/core.ts";
import { capabilities, type Capability as RuntimeCapability } from "../src/model.ts";

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

type CatalogSchema = {
  properties?: {
    capabilities?: {
      items?: {
        properties?: {
          tier?: {
            enum?: string[];
          };
        };
      };
    };
  };
};

const catalog = JSON.parse(
  readFileSync(new URL("../capabilities/catalog.json", import.meta.url), "utf8"),
) as Catalog;
const catalogSchema = JSON.parse(
  readFileSync(new URL("../schemas/capability-catalog.schema.json", import.meta.url), "utf8"),
) as CatalogSchema;

describe("capability catalog", () => {
  test("uses a stable schema version and exactly the shipped runtime capability names", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.capabilities.length).toBeGreaterThan(0);

    const names = catalog.capabilities.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...capabilities]);
  });

  test("declares script candidates that runtime discovery actually recognizes", () => {
    for (const capability of catalog.capabilities) {
      for (const candidate of capability.scriptCandidates) {
        const root = mkdtempSync(join(tmpdir(), "coding-tooling-capability-"));
        try {
          writeFileSync(
            join(root, "package.json"),
            `${JSON.stringify({ name: "fixture", scripts: { [candidate]: "echo ok" } })}\n`,
            "utf8",
          );
          const component = discoverComponents(root)[0];
          expect(component?.capabilities[capability.name as RuntimeCapability]).toBeDefined();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test("declares deterministic script candidates and schema-valid tiers", () => {
    const schemaTiers = new Set(
      catalogSchema.properties?.capabilities?.items?.properties?.tier?.enum ?? [],
    );
    expect(schemaTiers.size).toBeGreaterThan(0);

    for (const capability of catalog.capabilities) {
      expect(capability.scriptCandidates.length).toBeGreaterThan(0);
      expect(new Set(capability.scriptCandidates).size).toBe(capability.scriptCandidates.length);
      expect(schemaTiers.has(capability.tier)).toBe(true);
    }
  });

  test("keeps cross-candidate benchmark comparison outside tooling", () => {
    const byName = new Map(catalog.capabilities.map((capability) => [capability.name, capability]));

    expect(byName.get("web:audit")?.baselineRequired).toBe(true);
    expect(byName.get("benchmark")?.baselineRequired).toBe(false);
    expect(byName.has("benchmark:compare")).toBe(false);
  });

  test("includes framework-neutral progressive validation capabilities", () => {
    const byName = new Map(catalog.capabilities.map((capability) => [capability.name, capability]));

    expect(byName.get("test:integration:workflow")?.scriptCandidates).toEqual([
      "test:integration:workflow",
    ]);
    expect(byName.get("test:e2e:smoke")?.scriptCandidates).toEqual(["test:e2e:smoke"]);
    expect(byName.get("test:accessibility")?.scriptCandidates).toEqual(["test:accessibility"]);
    expect(byName.get("test:visual")?.scriptCandidates).toEqual(["test:visual"]);
    expect(byName.get("package:check")?.scriptCandidates).toEqual(["package:check"]);
  });
});
