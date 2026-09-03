import { describe, expect, test } from "bun:test";

import { parseCoverage, testCoverageJson } from "../site/test-coverage.js";

describe("GitHub Pages test coverage observation", () => {
  test("normalizes an Istanbul coverage summary", () => {
    expect(
      parseCoverage(
        JSON.stringify({
          total: {
            lines: { total: 10, covered: 8, skipped: 0, pct: 80 },
            statements: { total: 12, covered: 9, skipped: 0, pct: 75 },
            functions: { total: 4, covered: 3, skipped: 0, pct: 75 },
            branches: { total: 6, covered: 3, skipped: 0, pct: 50 },
          },
        }),
        "istanbul-summary",
      ),
    ).toEqual({
      lines: { covered: 8, total: 10, percent: 80 },
      statements: { covered: 9, total: 12, percent: 75 },
      functions: { covered: 3, total: 4, percent: 75 },
      branches: { covered: 3, total: 6, percent: 50 },
    });
  });

  test("aggregates LCOV totals without inventing statement coverage", () => {
    const coverage = parseCoverage(
      [
        "TN:",
        "SF:src/first.js",
        "FNF:2",
        "FNH:1",
        "LF:10",
        "LH:8",
        "BRF:4",
        "BRH:2",
        "end_of_record",
        "SF:src/second.js",
        "FNF:1",
        "FNH:1",
        "LF:5",
        "LH:5",
        "BRF:2",
        "BRH:2",
        "end_of_record",
      ].join("\n"),
      "lcov",
    );

    expect(coverage).toEqual({
      lines: { covered: 13, total: 15, percent: 86.67 },
      statements: null,
      functions: { covered: 2, total: 3, percent: 66.67 },
      branches: { covered: 4, total: 6, percent: 66.67 },
    });
  });

  test("reads a recognized default-branch report through the public GitHub API seam", async () => {
    const requests = [];
    const coverage = await testCoverageJson("example/repo", {
      now: new Date("2026-09-03T12:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({
            tree: [{ path: "coverage/coverage-summary.json", sha: "coverage", type: "blob" }],
            truncated: false,
          });
        if (url === "https://api.github.com/repos/example/repo/git/blobs/coverage")
          return encodedBlob(
            JSON.stringify({
              total: {
                lines: { total: 10, covered: 9, pct: 90 },
                statements: { total: 10, covered: 9, pct: 90 },
                functions: { total: 2, covered: 2, pct: 100 },
                branches: { total: 4, covered: 3, pct: 75 },
              },
            }),
          );
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.operation).toBe("test-coverage-observation");
    expect(coverage.summary).toEqual({
      status: "available",
      source: { path: "coverage/coverage-summary.json", format: "istanbul-summary" },
    });
    expect(coverage.coverage.lines.percent).toBe(90);
    expect(coverage.repository.fullName).toBe("example/repo");
    expect(requests).toHaveLength(3);
  });

  test("reports missing coverage as unavailable rather than zero", async () => {
    const coverage = await testCoverageJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({ tree: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.summary.status).toBe("unavailable");
    expect(coverage.coverage).toBeNull();
    expect(coverage.sources).toEqual([]);
  });

  test("marks a discovered but unreadable coverage report incomplete", async () => {
    const coverage = await testCoverageJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({
            tree: [{ path: "coverage/lcov.info", sha: "broken", type: "blob" }],
            truncated: false,
          });
        if (url === "https://api.github.com/repos/example/repo/git/blobs/broken")
          return encodedBlob("not lcov");
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.summary.status).toBe("incomplete");
    expect(coverage.coverage).toBeNull();
    expect(coverage.sources[0].status).toBe("unreadable");
  });
});

function githubRepositoryMetadata() {
  return {
    owner: { login: "example" },
    name: "repo",
    full_name: "example/repo",
    default_branch: "main",
    html_url: "https://github.com/example/repo",
  };
}

function encodedBlob(content) {
  return jsonResponse({ encoding: "base64", content: btoa(content) });
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
