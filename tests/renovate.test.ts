import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  installRenovateFoundation,
  RENOVATE_PRESET,
  renovateFoundationRecommendation,
} from "../src/renovate.ts";

function makeRepository(): string {
  return mkdtempSync(join(tmpdir(), "coding-tooling-renovate-"));
}

describe("Renovate foundation", () => {
  test("installs the small shared-preset consumer config", () => {
    const root = makeRepository();

    const result = installRenovateFoundation(root);

    expect(result.changed).toBe(true);
    expect(result.blockedByDependabot).toBe(false);
    expect(result.preset).toBe(RENOVATE_PRESET);
    expect(JSON.parse(readFileSync(join(root, "renovate.json"), "utf8"))).toEqual({
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      extends: [RENOVATE_PRESET],
    });
  });

  test("preserves an existing Renovate configuration", () => {
    const root = makeRepository();
    writeFileSync(join(root, "renovate.json5"), "{ extends: ['config:recommended'] }\n");

    const result = installRenovateFoundation(root);

    expect(result.changed).toBe(false);
    expect(result.existingConfigPath).toBe("renovate.json5");
    expect(readFileSync(join(root, "renovate.json5"), "utf8")).toBe(
      "{ extends: ['config:recommended'] }\n",
    );
  });

  test("blocks installation when a Dependabot updater config needs explicit migration", () => {
    const root = makeRepository();
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/dependabot.yml"), "version: 2\nupdates: []\n");

    const recommendation = renovateFoundationRecommendation(root);
    const result = installRenovateFoundation(root);

    expect(recommendation.dependabotConfigPath).toBe(".github/dependabot.yml");
    expect(result.changed).toBe(false);
    expect(result.blockedByDependabot).toBe(true);
    expect(() => readFileSync(join(root, "renovate.json"), "utf8")).toThrow();
  });
});
