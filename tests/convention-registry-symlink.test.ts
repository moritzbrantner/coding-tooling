import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { conventionRegistryCommand } from "../src/convention-registry.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

test("conventions check detects unexpected symlinks in the managed snapshot", () => {
  const source = workspace("convention-registry-");
  const target = workspace("convention-consumer-");
  try {
    write(source, "README.md", "# Conventions\n");
    write(source, "principles/README.md", "## PRINCIPLE-001 — Be explicit\n");
    write(source, "conventions/testing/README.md", "## TEST-001 — Test narrowly\n");
    write(
      source,
      "registry/registry.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          modules: {
            base: { sources: ["principles", "conventions"], dependencies: [] },
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(
      conventionRegistryCommand("init", ["base"], {
        root: target,
        conventionsRoot: source,
      }).status,
    ).toBe("passed");

    const managedRoot = join(target, ".conventions");
    symlinkSync(join(managedRoot, "index.md"), join(managedRoot, "unexpected.md"));

    const result = conventionRegistryCommand("check", [], { root: target });
    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "conventions-managed-file-drift" &&
          diagnostic.message.includes("unexpected.md"),
      ),
    ).toBe(true);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
