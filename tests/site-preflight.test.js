import { describe, expect, test } from "bun:test";

import { analysisJson } from "../site/github-analysis.js";
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
      blob("fixtures/app/package.json", "5"),
    ];
    expect(selectedRemoteFiles(tree, 3).map((entry) => entry.path)).toEqual([
      ".coding-tooling.json",
      ".node-version",
      "package.json",
    ]);
    expect(selectedRemoteFiles(tree).map((entry) => entry.path)).not.toContain(
      "fixtures/app/package.json",
    );
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

  test("ignores fixture components and accepts an exact Bun toolchain pin", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("bun.lock", "2"),
          blob("src/index.ts", "3"),
          blob("tests/index.test.ts", "4"),
          blob(".coding-tooling.json", "5"),
          blob("AGENTS.md", "6"),
          blob("renovate.json", "7"),
          blob(".github/workflows/validate.yml", "8"),
          blob("fixtures/app/package.json", "9"),
          blob("fixtures/rust/Cargo.toml", "10"),
          blob("fixtures/dotnet/App.csproj", "11"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4.0",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          "fixtures/app/package.json": JSON.stringify({ name: "ignored-fixture" }),
        },
      }),
    );
    expect(analysis.components.map((component) => [component.kind, component.path])).toEqual([
      ["package", "."],
    ]);
    expect(analysis.findings).toEqual([]);
  });

  test("reports a non-exact Bun toolchain pin", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob(".coding-tooling.json", "2"),
          blob("AGENTS.md", "3"),
          blob("renovate.json", "4"),
          blob(".github/workflows/validate.yml", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      }),
    );
    expect(analysis.findings.map((finding) => finding.id)).toEqual(["REMOTE-ENV-005"]);
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

  test("analysisJson resolves a repository through the public GitHub API seam", async () => {
    const requests = [];
    const analysis = await analysisJson("example/repo", {
      now: new Date("2026-09-02T20:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse({
            owner: { login: "example" },
            name: "repo",
            full_name: "example/repo",
            default_branch: "main",
            html_url: "https://github.com/example/repo",
            description: "fixture",
            archived: false,
            fork: false,
            stargazers_count: 3,
            open_issues_count: 1,
          });
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({ tree: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(analysis.operation).toBe("remote-preflight");
    expect(analysis.repository.fullName).toBe("example/repo");
    expect(analysis.generatedAt).toBe("2026-09-02T20:00:00.000Z");
    expect(requests).toHaveLength(2);
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

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
