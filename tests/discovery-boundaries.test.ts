import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { discoverComponents } from "../src/core.ts";

describe("repository discovery boundaries", () => {
  test("ignores transient tooling checkouts", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-discovery-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", scripts: { test: "bun test" } }),
    );

    const tooling = join(root, ".tooling", "coding-tooling");
    mkdirSync(tooling, { recursive: true });
    writeFileSync(
      join(tooling, "package.json"),
      JSON.stringify({ name: "coding-tooling", scripts: { lint: "oxlint ." } }),
    );

    expect(discoverComponents(root).map((component) => component.name)).toEqual(["consumer"]);
  });
});
