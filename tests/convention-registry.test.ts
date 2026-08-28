import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function registry(): string {
  const root = workspace("convention-registry-");
  write(root, "README.md", "# Conventions\n");
  write(root, "principles/README.md", "## PRINCIPLE-001 — Be explicit\n");
  write(root, "conventions/testing/README.md", "## TEST-001 — Test narrowly\n");
  write(root, "technologies/typescript/README.md", "## TS-001 — TypeScript rule\n");
  write(root, "technologies/typescript/react/README.md", "## REACT-001 — React rule\n");
  write(
    root,
    "registry/registry.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        modules: {
          base: { sources: ["principles", "conventions"], dependencies: [] },
          typescript: {
            sources: ["technologies/typescript/README.md"],
            dependencies: ["base"],
          },
          react: {
            sources: ["technologies/typescript/react/README.md"],
            dependencies: ["typescript"],
          },
        },
        profiles: { "react-app": ["react"] },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("installed convention registry", () => {
  test("installs selected modules with dependencies and verifies managed snapshots", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      const init = conventionRegistryCommand("init", ["react"], {
        root: target,
        conventionsRoot: source,
      });
      expect(init.status).toBe("passed");

      const manifest = JSON.parse(readFileSync(join(target, "conventions.json"), "utf8"));
      expect(manifest.modules).toEqual(["react"]);

      const lock = JSON.parse(readFileSync(join(target, "conventions.lock.json"), "utf8"));
      expect(lock.resolvedModules).toEqual(["base", "typescript", "react"]);
      expect(readFileSync(join(target, ".conventions/index.md"), "utf8")).toContain("## react");

      const check = conventionRegistryCommand("check", [], { root: target });
      expect(check.status).toBe("passed");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("detects local drift and update restores the managed snapshot", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      conventionRegistryCommand("init", ["react"], { root: target, conventionsRoot: source });
      const installed = join(
        target,
        ".conventions/modules/react/technologies/typescript/react/README.md",
      );
      writeFileSync(installed, "locally edited\n");

      const drifted = conventionRegistryCommand("check", [], { root: target });
      expect(drifted.status).toBe("failed");
      expect(drifted.diagnostics.some((diagnostic) => diagnostic.code === "conventions-managed-file-drift")).toBe(true);

      const update = conventionRegistryCommand("update", [], {
        root: target,
        conventionsRoot: source,
      });
      expect(update.status).toBe("passed");
      expect(conventionRegistryCommand("check", [], { root: target }).status).toBe("passed");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("reports available convention changes without mutating the consumer", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      conventionRegistryCommand("init", ["react"], { root: target, conventionsRoot: source });
      write(
        source,
        "technologies/typescript/react/README.md",
        "## REACT-001 — React rule\n\n- Updated policy.\n",
      );

      const diff = conventionRegistryCommand("diff", [], {
        root: target,
        conventionsRoot: source,
      });
      expect(diff.status).toBe("passed");
      expect(diff.data.updateAvailable).toBe(true);
      expect(diff.data.changed).toContain(
        "modules/react/technologies/typescript/react/README.md",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("supports profile-based installation", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      const result = conventionRegistryCommand("init", [], {
        root: target,
        conventionsRoot: source,
        profile: "react-app",
      });
      expect(result.status).toBe("passed");
      const manifest = JSON.parse(readFileSync(join(target, "conventions.json"), "utf8"));
      expect(manifest.modules).toEqual(["react"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
