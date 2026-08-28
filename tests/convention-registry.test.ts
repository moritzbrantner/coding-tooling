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

  test("initializes an empty selection into a checkable managed snapshot", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      expect(
        conventionRegistryCommand("init", [], { root: target, conventionsRoot: source }).status,
      ).toBe("passed");
      expect(conventionRegistryCommand("check", [], { root: target }).status).toBe("passed");
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
      expect(
        drifted.diagnostics.some(
          (diagnostic) => diagnostic.code === "conventions-managed-file-drift",
        ),
      ).toBe(true);

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
      expect(diff.data.changed).toContain("modules/react/technologies/typescript/react/README.md");
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

  test("rerunning init is an offline no-op after initialization", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      conventionRegistryCommand("init", ["react"], { root: target, conventionsRoot: source });
      rmSync(source, { recursive: true, force: true });

      const second = conventionRegistryCommand("init", [], { root: target });
      expect(second.status).toBe("passed");
      expect(second.data.unchanged).toBe(true);
      expect(second.data.modules).toEqual(["react"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("does not persist an init manifest when snapshot construction fails", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      const manifestPath = join(source, "registry/registry.json");
      const registryManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      registryManifest.modules.react.sources = ["missing.md"];
      writeFileSync(manifestPath, `${JSON.stringify(registryManifest, null, 2)}\n`);

      const result = conventionRegistryCommand("init", ["react"], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("error");
      expect(existsSync(join(target, "conventions.json"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects registry module names that can escape the managed directory", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      const manifestPath = join(source, "registry/registry.json");
      const registryManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      registryManifest.modules["../.."] = {
        sources: ["README.md"],
        dependencies: [],
      };
      writeFileSync(manifestPath, `${JSON.stringify(registryManifest, null, 2)}\n`);

      const result = conventionRegistryCommand("init", ["../.."], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("error");
      expect(existsSync(join(target, "README.md"))).toBe(false);
      expect(existsSync(join(target, "conventions.json"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects direct registry symlinks that resolve outside the source checkout", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    const external = workspace("convention-secret-");
    try {
      const secret = join(external, "secret.md");
      writeFileSync(secret, "do-not-copy\n");
      symlinkSync(secret, join(source, "leak.md"));

      const manifestPath = join(source, "registry/registry.json");
      const registryManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      registryManifest.modules.leak = { sources: ["leak.md"], dependencies: [] };
      writeFileSync(manifestPath, `${JSON.stringify(registryManifest, null, 2)}\n`);

      const result = conventionRegistryCommand("init", ["leak"], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("error");
      expect(existsSync(join(target, "conventions.json"))).toBe(false);
      expect(existsSync(join(target, ".conventions"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("rejects malformed consumer manifests and locks", () => {
    const target = workspace("convention-consumer-");
    try {
      writeFileSync(
        join(target, "conventions.json"),
        `${JSON.stringify({ schemaVersion: 1, registry: "coding-agent-conventions", modules: null })}\n`,
      );
      writeFileSync(
        join(target, "conventions.lock.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          sourceRevision: "abc",
          requestedModules: null,
          resolvedModules: [],
          files: {},
        })}\n`,
      );

      const result = conventionRegistryCommand("check", [], { root: target });
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe("conventions-manifest-missing");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
