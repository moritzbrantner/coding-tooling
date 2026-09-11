import { describe, expect, test } from "bun:test";

import { analyzeSnapshot } from "../site/preflight.js";

function blob(path, sha = path) {
  return { path, type: "blob", sha };
}

function scripts() {
  return {
    "format:check": "fmt",
    lint: "lint",
    typecheck: "typecheck",
    test: "test",
  };
}

function snapshot(manifests) {
  const files = {
    ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
    ".github/workflows/validate.yml": `name: Validate\non:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - run: bun run typecheck\n`,
  };
  for (const [path, manifest] of Object.entries(manifests)) files[path] = JSON.stringify(manifest);
  return {
    repository: {
      name: "fixture",
      fullName: "example/fixture",
      defaultBranch: "main",
    },
    tree: [
      ...Object.keys(manifests).map((path) => blob(path)),
      blob(".coding-tooling.json"),
      blob("AGENTS.md"),
      blob("renovate.json"),
      blob(".github/workflows/validate.yml"),
    ],
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    workflowFetchTruncated: false,
    unreadablePaths: [],
  };
}

function environmentFindings(analysis) {
  return analysis.findings.filter((finding) => finding.id.startsWith("REMOTE-ENV-"));
}

describe("proven workspace toolchain evidence", () => {
  test("inherits the exact root Bun identity and command manager for a workspace member", () => {
    const analysis = analyzeSnapshot(
      snapshot({
        "package.json": {
          name: "root",
          packageManager: "bun@1.4.0",
          workspaces: ["packages/*"],
          scripts: scripts(),
        },
        "packages/app/package.json": { name: "app", scripts: scripts() },
      }),
    );
    const app = analysis.components.find((component) => component.path === "packages/app");

    expect(app.workspace).toEqual(
      expect.objectContaining({ status: "satisfied", ownerPath: ".", pattern: "packages/*" }),
    );
    expect(app.toolchain).toEqual(
      expect.objectContaining({
        status: "satisfied",
        runtime: "bun",
        version: "1.4.0",
        reason: "workspace-toolchain-inherited",
        inheritedFrom: ".",
      }),
    );
    expect(app.capabilities.lint).toEqual(["bun", "run", "lint"]);
    expect(environmentFindings(analysis)).toEqual([]);
  });

  test("groups conflicting exact member identities into one workspace finding", () => {
    const analysis = analyzeSnapshot(
      snapshot({
        "package.json": {
          name: "root",
          packageManager: "bun@1.4.0",
          workspaces: ["packages/*"],
          scripts: scripts(),
        },
        "packages/a/package.json": {
          name: "a",
          packageManager: "bun@1.3.14",
          scripts: scripts(),
        },
        "packages/b/package.json": {
          name: "b",
          packageManager: "bun@1.3.14",
          scripts: scripts(),
        },
      }),
    );

    expect(environmentFindings(analysis).map((finding) => finding.id)).toEqual(["REMOTE-ENV-008"]);
    expect(environmentFindings(analysis)[0].evidence).toContain("packages/a");
    expect(environmentFindings(analysis)[0].evidence).toContain("packages/b");
    expect(
      analysis.components
        .filter((component) => component.path.startsWith("packages/"))
        .map((component) => component.toolchain.reason),
    ).toEqual(["workspace-toolchain-conflict", "workspace-toolchain-conflict"]);
  });

  test("supports the object workspaces packages form", () => {
    const analysis = analyzeSnapshot(
      snapshot({
        "package.json": {
          name: "root",
          packageManager: "bun@1.4.0",
          workspaces: { packages: ["packages/*"] },
          scripts: scripts(),
        },
        "packages/app/package.json": { name: "app", scripts: scripts() },
      }),
    );
    const app = analysis.components.find((component) => component.path === "packages/app");

    expect(app.workspace?.status).toBe("satisfied");
    expect(app.toolchain.reason).toBe("workspace-toolchain-inherited");
    expect(app.capabilities.typecheck).toEqual(["bun", "run", "typecheck"]);
  });

  test("does not infer membership from unsupported workspace patterns", () => {
    const analysis = analyzeSnapshot(
      snapshot({
        "package.json": {
          name: "root",
          packageManager: "bun@1.4.0",
          workspaces: ["packages/{app,web}"],
          scripts: scripts(),
        },
        "packages/app/package.json": { name: "app", scripts: scripts() },
      }),
    );
    const app = analysis.components.find((component) => component.path === "packages/app");

    expect(app.workspace).toBeUndefined();
    expect(app.toolchain.status).toBe("incomplete");
    expect(environmentFindings(analysis)).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^REMOTE-ENV-006-/) }),
    ]);
  });
});
