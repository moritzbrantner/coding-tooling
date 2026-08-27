import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConventions } from "../src/conventions.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

function conventions(): string {
  const root = workspace("coding-conventions-");
  write(root, "README.md", "# Conventions\n");
  write(root, "principles/README.md", "# Principles\n");
  write(root, "conventions/testing/README.md", "## TEST-001 — Test narrowly\n");
  write(root, "conventions/repository/README.md", "## REPO-001 — Keep local rules local\n");
  write(root, "technologies/typescript/README.md", "## TS-001 — TypeScript rule\n");
  write(root, "technologies/typescript/react/README.md", "## REACT-001 — React rule\n");
  write(root, "technologies/tooling/README.md", "# Tooling\n");
  write(root, "technologies/tooling/vite/README.md", "## VITE-001 — Vite rule\n");
  return root;
}

function repository(): string {
  const root = workspace("coding-repository-");
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      dependencies: { react: "1", vite: "1" },
    }),
  );
  write(root, "tsconfig.json", "{}\n");
  write(root, "AGENTS.md", "# Local instructions\n");
  write(
    root,
    ".coding-tooling.json",
    JSON.stringify({ schemaVersion: 1, conventionRefs: ["TEST-001"] }),
  );
  return root;
}

describe("convention resolution", () => {
  test("loads current general and inferred technology conventions without copying them", () => {
    const source = conventions();
    const target = repository();
    try {
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("passed");
      expect(result.operation).toBe("conventions");
      expect(result.data.technologies).toEqual(["javascript", "react", "typescript", "vite"]);
      const paths = (result.data.files as Array<{ path: string }>).map((file) => file.path);
      expect(paths).toContain("principles/README.md");
      expect(paths).toContain("conventions/testing/README.md");
      expect(paths).toContain("technologies/typescript/README.md");
      expect(paths).toContain("technologies/typescript/react/README.md");
      expect(paths).toContain("technologies/tooling/README.md");
      expect(paths).toContain("technologies/tooling/vite/README.md");
      expect(result.data.explicitRefs).toEqual({ "TEST-001": "conventions/testing/README.md" });
      expect(result.data.localInstructions).toEqual([join(target, "AGENTS.md")]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("resolves the conventions checkout through the machine registry", () => {
    const source = conventions();
    const target = repository();
    const registryRoot = workspace("coding-registry-");
    const registry = join(registryRoot, "environment.toml");
    try {
      writeFileSync(
        registry,
        `schema_version = 1\n\n[components.coding-agent-conventions]\npath = ${JSON.stringify(source)}\nobserved_revision = "fixture"\n`,
      );
      const result = resolveConventions({ root: target, registryPath: registry });
      expect(result.status).toBe("passed");
      expect(result.data.source).toBe("registry");
      expect(result.data.sourceRoot).toBe(source);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(registryRoot, { recursive: true, force: true });
    }
  });

  test("fails when a configured stable convention ID disappears", () => {
    const source = conventions();
    const target = repository();
    try {
      write(
        target,
        ".coding-tooling.json",
        JSON.stringify({ schemaVersion: 1, conventionRefs: ["MISSING-999"] }),
      );
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.code).toBe("convention-ref-unresolved");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
