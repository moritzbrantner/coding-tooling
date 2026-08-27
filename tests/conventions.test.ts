import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalogConventions, resolveConventions } from "../src/conventions.ts";

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
  write(root, "technologies/tooling/README.md", "## TOOL-001 — Tooling rule\n");
  write(root, "technologies/tooling/vite/README.md", "## VITE-001 — Vite rule\n");
  write(root, "technologies/tooling/playwright/README.md", "## PLAYWRIGHT-001 — Playwright rule\n");
  write(root, "technologies/databases/README.md", "## DB-001 — Database rule\n");
  write(root, "technologies/databases/postgres/README.md", "## POSTGRES-001 — Postgres rule\n");
  write(root, "technologies/docker/README.md", "## DOCKER-001 — Docker rule\n");
  write(root, "technologies/docker/dockerfile/README.md", "## DOCKERFILE-001 — Dockerfile rule\n");
  write(
    root,
    "catalog.source.json",
    JSON.stringify({
      schemaVersion: 1,
      scopes: {
        typescript: { path: "technologies/typescript/README.md" },
        react: { path: "technologies/typescript/react/README.md", parents: ["typescript"] },
        tooling: { path: "technologies/tooling/README.md" },
        vite: { path: "technologies/tooling/vite/README.md", parents: ["tooling"] },
        playwright: {
          path: "technologies/tooling/playwright/README.md",
          parents: ["tooling"],
        },
        databases: { path: "technologies/databases/README.md" },
        postgres: { path: "technologies/databases/postgres/README.md", parents: ["databases"] },
        docker: { path: "technologies/docker/README.md" },
        dockerfile: { path: "technologies/docker/dockerfile/README.md", parents: ["docker"] },
      },
      profiles: {
        "react-vite-library": { scopes: ["react", "vite"] },
      },
    }),
  );
  write(
    root,
    "catalog.json",
    JSON.stringify({
      schemaVersion: 1,
      principles: ["principles/README.md"],
      general: ["conventions/repository/README.md", "conventions/testing/README.md"],
      scopes: {
        typescript: { path: "technologies/typescript/README.md" },
        react: { path: "technologies/typescript/react/README.md", parents: ["typescript"] },
        tooling: { path: "technologies/tooling/README.md" },
        vite: { path: "technologies/tooling/vite/README.md", parents: ["tooling"] },
        playwright: {
          path: "technologies/tooling/playwright/README.md",
          parents: ["tooling"],
        },
        databases: { path: "technologies/databases/README.md" },
        postgres: { path: "technologies/databases/postgres/README.md", parents: ["databases"] },
        docker: { path: "technologies/docker/README.md" },
        dockerfile: { path: "technologies/docker/dockerfile/README.md", parents: ["docker"] },
      },
      profiles: {
        "react-vite-library": { scopes: ["react", "vite"] },
      },
      conventionIds: {
        "DB-001": "technologies/databases/README.md",
        "DOCKER-001": "technologies/docker/README.md",
        "DOCKERFILE-001": "technologies/docker/dockerfile/README.md",
        "PLAYWRIGHT-001": "technologies/tooling/playwright/README.md",
        "POSTGRES-001": "technologies/databases/postgres/README.md",
        "REACT-001": "technologies/typescript/react/README.md",
        "REPO-001": "conventions/repository/README.md",
        "TEST-001": "conventions/testing/README.md",
        "TOOL-001": "technologies/tooling/README.md",
        "TS-001": "technologies/typescript/README.md",
        "VITE-001": "technologies/tooling/vite/README.md",
      },
    }),
  );
  return root;
}

function repository(): string {
  const root = workspace("coding-repository-");
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      packageManager: "bun@1.3.14",
      dependencies: { react: "1", vite: "1" },
    }),
  );
  write(root, "tsconfig.json", "{}\n");
  write(root, "AGENTS.md", "# Local instructions\n");
  write(root, "packages/widget/AGENTS.md", "# Widget instructions\n");
  write(
    root,
    ".coding-tooling.json",
    JSON.stringify({ schemaVersion: 1, conventionRefs: ["TEST-001"] }),
  );
  return root;
}

describe("convention resolution", () => {
  test("generates and checks the compact convention catalog", () => {
    const source = conventions();
    try {
      const written = catalogConventions({ conventionsRoot: source, write: true });
      expect(written.status).toBe("passed");
      expect(written.data.wrote).toBe(true);
      expect(written.data.matches).toBe(true);

      write(source, "catalog.json", "{}\n");
      const checked = catalogConventions({ conventionsRoot: source, check: true });
      expect(checked.status).toBe("failed");
      expect(checked.diagnostics[0]?.code).toBe("conventions-catalog-stale");
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("loads current general and inferred technology conventions without copying them", () => {
    const source = conventions();
    const target = repository();
    try {
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("passed");
      expect(result.operation).toBe("conventions");
      expect(result.data.technologies).toEqual([
        "javascript",
        "react",
        "tooling",
        "typescript",
        "vite",
      ]);
      const paths = (result.data.files as Array<{ path: string }>).map((file) => file.path);
      expect(paths).toContain("principles/README.md");
      expect(paths).toContain("conventions/testing/README.md");
      expect(paths).toContain("technologies/typescript/README.md");
      expect(paths).toContain("technologies/typescript/react/README.md");
      expect(paths).toContain("technologies/tooling/README.md");
      expect(paths).toContain("technologies/tooling/vite/README.md");
      expect(result.data.conventionIds).toEqual([
        "REACT-001",
        "REPO-001",
        "TEST-001",
        "TOOL-001",
        "TS-001",
        "VITE-001",
      ]);
      expect(result.data.explicitRefs).toEqual({ "TEST-001": "conventions/testing/README.md" });
      expect(result.data.localInstructions).toEqual([
        join(target, "AGENTS.md"),
        join(target, "packages/widget/AGENTS.md"),
      ]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("infers conventions from peer and optional dependencies", () => {
    const source = conventions();
    const target = repository();
    try {
      write(
        target,
        "package.json",
        JSON.stringify({
          name: "fixture",
          peerDependencies: { react: "1" },
          optionalDependencies: { "@playwright/test": "1" },
        }),
      );
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("passed");
      expect(result.data.technologies).toEqual([
        "javascript",
        "playwright",
        "react",
        "tooling",
        "typescript",
      ]);
      const paths = (result.data.files as Array<{ path: string }>).map((file) => file.path);
      expect(paths).toContain("technologies/typescript/react/README.md");
      expect(paths).toContain("technologies/tooling/playwright/README.md");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("includes database and Docker parent scopes from repository signals", () => {
    const source = conventions();
    const target = repository();
    try {
      write(
        target,
        "package.json",
        JSON.stringify({
          name: "fixture",
          dependencies: { pg: "1" },
        }),
      );
      write(target, "Dockerfile", "FROM scratch\n");
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("passed");
      expect(result.data.technologies).toEqual([
        "databases",
        "docker",
        "dockerfile",
        "javascript",
        "postgres",
        "typescript",
      ]);
      const paths = (result.data.files as Array<{ path: string }>).map((file) => file.path);
      expect(paths).toContain("technologies/databases/README.md");
      expect(paths).toContain("technologies/databases/postgres/README.md");
      expect(paths).toContain("technologies/docker/README.md");
      expect(paths).toContain("technologies/docker/dockerfile/README.md");
      expect(result.data.conventionIds).toContain("DB-001");
      expect(result.data.conventionIds).toContain("POSTGRES-001");
      expect(result.data.conventionIds).toContain("DOCKER-001");
      expect(result.data.conventionIds).toContain("DOCKERFILE-001");
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

  test("resolves a declared profile without widening it from inferred technologies", () => {
    const source = conventions();
    const target = repository();
    try {
      write(
        target,
        ".coding-tooling.json",
        JSON.stringify({
          schemaVersion: 1,
          conventionProfile: "react-vite-library",
          conventionRefs: ["TEST-001"],
        }),
      );
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("passed");
      expect(result.data.profile).toBe("react-vite-library");
      expect(result.data.resolvedScopes).toEqual(["typescript", "react", "tooling", "vite"]);
      expect(result.data.undeclaredTechnologies).toEqual([]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("reports undeclared inferred scopes as profile drift", () => {
    const source = conventions();
    const target = repository();
    try {
      write(
        target,
        "package.json",
        JSON.stringify({
          name: "fixture",
          packageManager: "bun@1.3.14",
          dependencies: { react: "1", vite: "1" },
          devDependencies: { "@playwright/test": "1" },
        }),
      );
      write(
        target,
        ".coding-tooling.json",
        JSON.stringify({ schemaVersion: 1, conventionProfile: "react-vite-library" }),
      );
      const result = resolveConventions({ root: target, conventionsRoot: source });
      expect(result.status).toBe("failed");
      expect(result.data.undeclaredTechnologies).toEqual(["playwright"]);
      expect(result.diagnostics[0]?.code).toBe("convention-scope-undeclared");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("reports explicit exceptions and emits compact relative paths", () => {
    const source = conventions();
    const target = repository();
    try {
      write(
        target,
        ".coding-tooling.json",
        JSON.stringify({
          schemaVersion: 1,
          conventionProfile: "react-vite-library",
          conventionExceptions: [{ id: "VITE-001", reason: "Library build owns no dev server" }],
        }),
      );
      const result = resolveConventions({
        root: target,
        conventionsRoot: source,
        compact: true,
      });
      expect(result.status).toBe("passed");
      expect(result.data.exceptions).toEqual([
        { id: "VITE-001", reason: "Library build owns no dev server" },
      ]);
      expect(result.data.conventionIdCount).toBe(
        (result.data.effectiveConventionIdCount as number) + 1,
      );
      expect(result.data.localInstructions).toEqual(["AGENTS.md", "packages/widget/AGENTS.md"]);
      expect(result.data).not.toHaveProperty("root");
      expect((result.data.files as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
        "absolutePath",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
