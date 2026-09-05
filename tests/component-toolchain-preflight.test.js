import { describe, expect, test } from "bun:test";

import { analyzeSnapshot, selectedRemoteFiles } from "../site/preflight.js";

function blob(path, sha = path) {
  return { path, type: "blob", sha };
}

function snapshot(tree, files) {
  return {
    repository: {
      name: "fixture",
      fullName: "example/fixture",
      defaultBranch: "main",
    },
    tree,
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
  };
}

function scripts() {
  return {
    "format:check": "fmt",
    lint: "lint",
    typecheck: "typecheck",
    test: "test",
  };
}

describe("remote component toolchain evidence", () => {
  test("selects nested Node pins without displacing higher-priority manifests", () => {
    const tree = [
      blob("package.json"),
      blob(".coding-tooling.json"),
      blob(".node-version"),
      blob("packages/app/package.json"),
      blob("packages/app/.node-version"),
    ];

    expect(selectedRemoteFiles(tree, 4).map((entry) => entry.path)).toEqual([
      ".coding-tooling.json",
      ".node-version",
      "package.json",
      "packages/app/package.json",
    ]);
    expect(selectedRemoteFiles(tree, 5).map((entry) => entry.path)).toContain(
      "packages/app/.node-version",
    );
  });

  test("keeps root Bun and nested Node toolchains independent", () => {
    const analysis = analyzeSnapshot(
      snapshot(
        [
          blob("package.json"),
          blob("bun.lock"),
          blob("packages/app/package.json"),
          blob("packages/app/.node-version"),
          blob("packages/app/package-lock.json"),
          blob("src/index.ts"),
          blob("tests/index.test.ts"),
          blob(".coding-tooling.json"),
          blob("AGENTS.md"),
          blob("renovate.json"),
          blob(".github/workflows/validate.yml"),
        ],
        {
          "package.json": JSON.stringify({
            name: "root",
            packageManager: "bun@1.4.0",
            scripts: scripts(),
          }),
          "packages/app/package.json": JSON.stringify({ name: "app", scripts: scripts() }),
          "packages/app/.node-version": "24.20.0\n",
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      ),
    );
    const root = analysis.components.find((component) => component.path === ".");
    const app = analysis.components.find((component) => component.path === "packages/app");

    expect(root.toolchain).toEqual(
      expect.objectContaining({ status: "satisfied", manager: "bun", runtime: "bun" }),
    );
    expect(app.toolchain).toEqual(
      expect.objectContaining({
        status: "satisfied",
        manager: "npm",
        runtime: "node",
        version: "24.20.0",
      }),
    );
    expect(root.capabilities.lint).toEqual(["bun", "run", "lint"]);
    expect(app.capabilities.lint).toEqual(["npm", "run", "lint"]);
    expect(analysis.findings.filter((finding) => finding.id.startsWith("REMOTE-ENV-"))).toEqual(
      [],
    );
  });

  test("serializes missing nested toolchain evidence as incomplete instead of satisfied", () => {
    const analysis = analyzeSnapshot(
      snapshot(
        [
          blob("package.json"),
          blob("bun.lock"),
          blob("packages/app/package.json"),
          blob("src/index.ts"),
          blob("tests/index.test.ts"),
          blob(".coding-tooling.json"),
          blob("AGENTS.md"),
          blob("renovate.json"),
          blob(".github/workflows/validate.yml"),
        ],
        {
          "package.json": JSON.stringify({
            name: "root",
            packageManager: "bun@1.4.0",
            scripts: scripts(),
          }),
          "packages/app/package.json": JSON.stringify({ name: "app", scripts: scripts() }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      ),
    );
    const app = analysis.components.find((component) => component.path === "packages/app");
    const finding = analysis.findings.find((item) => item.id.startsWith("REMOTE-ENV-006-"));

    expect(app.toolchain.status).toBe("incomplete");
    expect(app.capabilities.lint).toEqual(["npm", "run", "lint"]);
    expect(finding).toEqual(
      expect.objectContaining({
        severity: "medium",
        title: "app: Node toolchain pin is missing",
      }),
    );
  });
});
