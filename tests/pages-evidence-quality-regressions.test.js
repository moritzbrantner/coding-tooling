import { describe, expect, test } from "bun:test";

import { analysisKpisJson } from "../site/analysis-kpis.js";
import { analyzeSnapshot } from "../site/preflight.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("Pages evidence-quality regressions", () => {
  test("respects repository-declared required capabilities and configured commands", () => {
    const analysis = analyzeSnapshot({
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
      tree: [
        blob("package.json"),
        blob("bun.lock"),
        blob("src/index.ts"),
        blob("tests/index.test.ts"),
        blob(".coding-tooling.json"),
        blob("AGENTS.md"),
        blob("renovate.json"),
        blob(".github/workflows/validate.yml"),
      ],
      files: {
        "package.json": JSON.stringify({
          name: "fixture",
          packageManager: "bun@1.4.0",
          scripts: { test: "test" },
        }),
        ".coding-tooling.json": JSON.stringify({
          schemaVersion: 1,
          requiredCapabilities: ["lint"],
          capabilityCommands: {
            ".": {
              lint: ["bunx", "oxlint@1.80.0", "--format=github"],
            },
          },
        }),
        ".github/workflows/validate.yml": `name: Validate\non:\n  pull_request:\njobs:\n  validate:\n    steps:\n      - run: bunx oxlint@1.80.0 --format=github\n`,
      },
      treeTruncated: false,
      manifestFetchTruncated: false,
      workflowFetchTruncated: false,
      unreadablePaths: [],
    });

    const component = analysis.components.find((item) => item.name === "fixture");
    expect(component.configuredCapabilities).toEqual({
      lint: ["bunx", "oxlint@1.80.0", "--format=github"],
    });
    expect(component.capabilities.lint).toEqual([
      "bunx",
      "oxlint@1.80.0",
      "--format=github",
    ]);
    expect(analysis.validationEvidence.status).toBe("satisfied");
    expect(analysis.findings.filter((finding) => finding.id.startsWith("REMOTE-CAPABILITY"))).toEqual(
      [],
    );
  });

  test("treats explicitly foreign score history as unrelated evidence", async () => {
    const result = await kpisWithHistory({
      schema_version: "runtime-profiler/score-history/v1",
      repository: "example/repo",
      entries: [],
    });

    expect(result.verification).toEqual(
      expect.objectContaining({
        status: "unavailable",
        freshness: "unknown",
        reason: "foreign-score-history-schema",
        foreignSchema: "runtime-profiler/score-history/v1",
      }),
    );
  });

  test("keeps malformed untagged score history fail closed", async () => {
    const result = await kpisWithHistory({
      repository: "example/repo",
      entries: [],
    });

    expect(result.verification).toEqual(
      expect.objectContaining({
        status: "incomplete",
        reason: "unsupported-score-history-schema",
      }),
    );
  });
});

async function kpisWithHistory(history) {
  return analysisKpisJson(
    { owner: "example", name: "repo" },
    { summary: { findingCount: 0, highPriorityFindingCount: 0 } },
    {
      repository: {
        fullName: "example/repo",
        openIssues: 0,
        revision,
      },
    },
    {
      fetchImpl: async (url) => {
        if (url.includes("history.json")) return fileResponse(history);
        return jsonResponse({}, 404);
      },
    },
  );
}

function blob(path) {
  return { path, sha: path, type: "blob" };
}

function fileResponse(value) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  });
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
