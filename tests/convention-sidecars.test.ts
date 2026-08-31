import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { conventionRegistryCommand } from "../src/convention-registry.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

describe("convention enforcement sidecars", () => {
  test("installs explicitly registered non-Markdown sidecars", () => {
    const source = workspace("convention-sidecar-source-");
    const target = workspace("convention-sidecar-target-");
    write(source, "README.md", "# Conventions\n");
    write(source, "principles/README.md", "# Principles\n");
    write(source, "conventions/testing/README.md", "## TEST-001 — Test narrowly\n");
    write(source, "technologies/typescript/README.md", "## TS-003 — Prefer type\n");
    write(
      source,
      "technologies/typescript/TS-003.json",
      `${JSON.stringify({
        schemaVersion: 1,
        ruleId: "TS-003",
        enforcement: {
          kind: "oxlint",
          technologies: ["typescript"],
          config: { rules: { "typescript/consistent-type-definitions": ["error", "type"] } },
        },
      })}\n`,
    );
    write(
      source,
      "registry/registry.json",
      `${JSON.stringify({
        schemaVersion: 1,
        modules: {
          typescript: {
            sources: ["technologies/typescript/README.md", "technologies/typescript/TS-003.json"],
            dependencies: [],
          },
        },
      })}\n`,
    );

    const result = conventionRegistryCommand("init", ["typescript"], {
      root: target,
      conventionsRoot: source,
    });

    expect(result.status).toBe("passed");
    const installed = join(
      target,
      ".conventions/modules/typescript/technologies/typescript/TS-003.json",
    );
    expect(existsSync(installed)).toBe(true);
    expect(JSON.parse(readFileSync(installed, "utf8")).ruleId).toBe("TS-003");
  });
});
