import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function registry(asset = "technologies/typescript/.toolrc.json"): string {
  const root = workspace("convention-assets-source-");
  write(root, "README.md", "# Conventions\n");
  write(root, "principles/README.md", "## PRINCIPLE-001 — Be explicit\n");
  write(root, "conventions/README.md", "# General conventions\n");
  write(root, "technologies/typescript/README.md", "## TS-001 — TypeScript rule\n");
  write(root, asset, `${JSON.stringify({ enabled: true }, null, 2)}\n`);
  write(
    root,
    "registry/registry.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        modules: {
          base: { sources: ["principles/README.md"], dependencies: [] },
          typescript: {
            sources: ["technologies/typescript/README.md"],
            assets: [asset],
            dependencies: ["base"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("convention companion assets", () => {
  test("installs and hashes explicit dotfile assets", () => {
    const source = registry();
    const target = workspace("convention-assets-target-");
    try {
      const result = conventionRegistryCommand("init", ["typescript"], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("passed");
      const installed = join(
        target,
        ".conventions/modules/typescript/technologies/typescript/.toolrc.json",
      );
      expect(readFileSync(installed, "utf8")).toContain('"enabled": true');
      const lock = JSON.parse(readFileSync(join(target, "conventions.lock.json"), "utf8"));
      expect(
        lock.files["modules/typescript/technologies/typescript/.toolrc.json"],
      ).toMatch(/^[a-f0-9]{64}$/);
      expect(conventionRegistryCommand("check", [], { root: target }).status).toBe("passed");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("detects asset drift, reports upstream asset changes, and update restores them", () => {
    const source = registry();
    const target = workspace("convention-assets-target-");
    try {
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      const installed = join(
        target,
        ".conventions/modules/typescript/technologies/typescript/.toolrc.json",
      );
      writeFileSync(installed, "locally changed\n");
      const check = conventionRegistryCommand("check", [], { root: target });
      expect(check.status).toBe("failed");
      expect(check.data.drift).toContain(
        "modules/typescript/technologies/typescript/.toolrc.json",
      );

      write(source, "technologies/typescript/.toolrc.json", '{"enabled":false}\n');
      const diff = conventionRegistryCommand("diff", [], {
        root: target,
        conventionsRoot: source,
      });
      expect(diff.status).toBe("passed");
      expect(diff.data.changed).toContain(
        "modules/typescript/technologies/typescript/.toolrc.json",
      );

      const update = conventionRegistryCommand("update", [], {
        root: target,
        conventionsRoot: source,
      });
      expect(update.status).toBe("passed");
      expect(readFileSync(installed, "utf8")).toBe('{"enabled":false}\n');
      expect(conventionRegistryCommand("check", [], { root: target }).status).toBe("passed");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("fails clearly when a declared asset is missing", () => {
    const source = registry();
    const target = workspace("convention-assets-target-");
    try {
      rmSync(join(source, "technologies/typescript/.toolrc.json"));
      const result = conventionRegistryCommand("init", ["typescript"], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("error");
      expect(result.diagnostics[0]?.message).toContain("Convention asset does not exist");
      expect(existsSync(join(target, "conventions.json"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects asset symlinks that escape the convention repository", () => {
    const source = registry();
    const target = workspace("convention-assets-target-");
    const external = workspace("convention-assets-external-");
    try {
      const asset = join(source, "technologies/typescript/.toolrc.json");
      rmSync(asset);
      const secret = join(external, "secret.json");
      writeFileSync(secret, '{"secret":true}\n');
      symlinkSync(secret, asset);
      const result = conventionRegistryCommand("init", ["typescript"], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("error");
      expect(result.diagnostics[0]?.message).toContain("escapes registry root");
      expect(existsSync(join(target, ".conventions"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
