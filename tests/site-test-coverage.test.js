import { describe, expect, test } from "bun:test";

import { buildTestCoverageSnapshot } from "../scripts/build-test-coverage-snapshot.js";
import { parseCoverage, parsePublishedSnapshot, testCoverageJson } from "../site/test-coverage.js";

const revision = "1111111111111111111111111111111111111111";

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
    const coverage = parseCoverage(sampleLcov(), "lcov");

    expect(coverage).toEqual({
      lines: { covered: 13, total: 15, percent: 86.67 },
      statements: null,
      functions: { covered: 2, total: 3, percent: 66.67 },
      branches: { covered: 4, total: 6, percent: 66.67 },
    });
  });

  test("builds the stable publication snapshot without thresholds", () => {
    const coverage = parseCoverage(sampleLcov(), "lcov");
    const snapshot = buildTestCoverageSnapshot({
      coverage,
      repository: "example/repo",
      revision,
      generatedAt: "2026-09-03T13:30:00Z",
      sourcePath: "coverage/lcov.info",
      sourceFormat: "lcov",
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      kind: "coding-tooling-test-coverage-snapshot",
      repository: { fullName: "example/repo", revision },
      generatedAt: "2026-09-03T13:30:00.000Z",
      producer: { id: "coding-tooling", protocolVersion: 1 },
      source: { path: "coverage/lcov.info", format: "lcov" },
      coverage,
    });
    expect(snapshot).not.toHaveProperty("threshold");
  });

  test("validates a published snapshot against repository provenance", () => {
    const parsed = parsePublishedSnapshot(
      JSON.stringify(publishedSnapshot({ repository: "example/repo", revision })),
      "example/repo",
    );
    expect(parsed.repository.revision).toBe(revision);
    expect(() =>
      parsePublishedSnapshot(
        JSON.stringify(publishedSnapshot({ repository: "other/repo", revision })),
        "example/repo",
      ),
    ).toThrow("does not match");
  });

  test("prefers the standardized published snapshot and reports exact freshness", async () => {
    const requests = [];
    const coverage = await testCoverageJson("example/repo", {
      now: new Date("2026-09-03T14:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === publishedUrl())
          return encodedFile(
            JSON.stringify(publishedSnapshot({ repository: "example/repo", revision })),
          );
        if (url === "https://api.github.com/repos/example/repo/branches/main")
          return jsonResponse({ commit: { sha: revision } });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.summary).toEqual({
      status: "available",
      source: {
        path: ".coding-tooling/test-coverage.json",
        branch: "coding-tooling-observations",
        format: "coding-tooling-snapshot-v1",
      },
      freshness: "current",
    });
    expect(coverage.publication).toEqual({
      revision,
      generatedAt: "2026-09-03T13:30:00.000Z",
      freshness: "current",
    });
    expect(coverage.coverage.lines.percent).toBe(86.67);
    expect(requests).toHaveLength(3);
  });

  test("keeps stale published coverage visible instead of pretending it is current", async () => {
    const coverage = await testCoverageJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === publishedUrl())
          return encodedFile(
            JSON.stringify(publishedSnapshot({ repository: "example/repo", revision })),
          );
        if (url === "https://api.github.com/repos/example/repo/branches/main")
          return jsonResponse({ commit: { sha: "2222222222222222222222222222222222222222" } });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.summary.status).toBe("available");
    expect(coverage.summary.freshness).toBe("stale");
  });

  test("reads a recognized default-branch report when no snapshot is published", async () => {
    const requests = [];
    const coverage = await testCoverageJson("example/repo", {
      now: new Date("2026-09-03T12:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === publishedUrl()) return jsonResponse({}, 404);
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
    expect(coverage.publication).toBeNull();
    expect(coverage.repository.fullName).toBe("example/repo");
    expect(requests).toHaveLength(4);
  });

  test("reports missing coverage as unavailable rather than zero", async () => {
    const coverage = await testCoverageJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === publishedUrl()) return jsonResponse({}, 404);
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({ tree: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.summary.status).toBe("unavailable");
    expect(coverage.coverage).toBeNull();
    expect(coverage.sources).toEqual([]);
  });

  test("marks a malformed published snapshot incomplete instead of falling through", async () => {
    const coverage = await testCoverageJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === publishedUrl()) return encodedFile("not json");
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(coverage.summary.status).toBe("incomplete");
    expect(coverage.coverage).toBeNull();
    expect(coverage.sources[0].status).toBe("unreadable");
  });

  test("marks a discovered but unreadable committed coverage report incomplete", async () => {
    const coverage = await testCoverageJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === publishedUrl()) return jsonResponse({}, 404);
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

function publishedSnapshot({ repository, revision: snapshotRevision }) {
  return buildTestCoverageSnapshot({
    coverage: parseCoverage(sampleLcov(), "lcov"),
    repository,
    revision: snapshotRevision,
    generatedAt: "2026-09-03T13:30:00Z",
    sourcePath: "coverage/lcov.info",
    sourceFormat: "lcov",
  });
}

function sampleLcov() {
  return [
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
  ].join("\n");
}

function githubRepositoryMetadata() {
  return {
    owner: { login: "example" },
    name: "repo",
    full_name: "example/repo",
    default_branch: "main",
    html_url: "https://github.com/example/repo",
  };
}

function publishedUrl() {
  return "https://api.github.com/repos/example/repo/contents/.coding-tooling/test-coverage.json?ref=coding-tooling-observations";
}

function encodedFile(content) {
  return jsonResponse({ type: "file", encoding: "base64", content: btoa(content) });
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
