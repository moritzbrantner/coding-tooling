import { describe, expect, test } from "bun:test";

import {
  analyzeSnapshot,
  parseRepositoryReference,
  selectedRemoteFiles,
} from "../site/preflight.js";

describe("GitHub Pages repository preflight", () => {
  test("parses shorthand and GitHub URLs", () => {
    expect(parseRepositoryReference("moritzbrantner/coding-tooling")).toEqual({
      owner: "moritzbrantner",
      name: "coding-tooling",
    });
    expect(
      parseRepositoryReference("https://github.com/moritzbrantner/coding-tooling/tree/main/src"),
    ).toEqual({ owner: "moritzbrantner", name: "coding-tooling" });
    expect(parseRepositoryReference("https://example.com/owner/repo")).toBeNull();
  });

  test("prioritizes remote foundation evidence before nested manifests", () => {
    const tree = [
      blob("packages/app/package.json", "1"),
      blob("package.json", "2"),
      blob(".coding-tooling.json", "3"),
      blob(".node-version", "4"),
    ];
    expect(selectedRemoteFiles(tree, 3).map((entry) => entry.path)).toEqual([
      ".coding-tooling.json",
      ".node-version",
      "package.json",
    ]);
  });

  test("returns a ready result for a repository with structural foundation evidence", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("tsconfig.json", "2"),
          blob("bun.lock", "3"),
          blob("src/index.ts", "4"),
          blob("tests/index.test.ts", "5"),
          blob(".coding-tooling.json", "6"),
          blob(".node-version", "7"),
          blob("AGENTS.md", "8"),
          blob("renovate.json", "9"),
          blob(".github/workflows/validate.yml", "10"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".node-version": "24.20.0\n",
        },
      }),
      new Date("2026-09-02T18:00:00.000Z"),
    );
    expect(analysis.summary.status).toBe("ready");
    expect(analysis.technologies).toEqual(["javascript", "typescript"]);
    expect(analysis.findings).toEqual([]);
  });

  test("marks truncated or bounded GitHub evidence incomplete", () => {
    const treeTruncated = analyzeSnapshot(repository({ tree: [], treeTruncated: true }));
    expect(treeTruncated.summary.status).toBe("incomplete");
    expect(treeTruncated.findings.map((finding) => finding.id)).toContain("REMOTE-SOURCE-001");

    const manifestBounded = analyzeSnapshot(
      repository({ tree: [blob("package.json", "1")], manifestFetchTruncated: true }),
    );
    expect(manifestBounded.summary.status).toBe("incomplete");
    expect(manifestBounded.findings.map((finding) => finding.id)).toContain("REMOTE-SOURCE-002");
  });
});

function repository(overrides) {
  return {
    repository: {
      owner: "example",
      name: "repo",
      fullName: "example/repo",
      defaultBranch: "main",
      htmlUrl: "https://github.com/example/repo",
      description: null,
      archived: false,
      fork: false,
      stars: 0,
      openIssues: 0,
    },
    tree: [],
    files: {},
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
    ...overrides,
  };
}

function blob(path, sha) {
  return { path, sha, type: "blob" };
}
