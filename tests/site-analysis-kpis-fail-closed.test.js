import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { analysisKpisJson } from "../site/analysis-kpis.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("GitHub Pages KPI fail-closed evidence", () => {
  test("marks an exact-revision score-production error tombstone incomplete", async () => {
    const scoreHistory = {
      schemaVersion: "coding-tooling/score-history/v1",
      repository: "example/repo",
      entries: [
        {
          commit: revision,
          score: null,
          verification: {
            status: "error",
            score: null,
            plannedChecks: 0,
            passedChecks: 0,
            failedChecks: 0,
            errorChecks: 0,
            blockedChecks: 0,
            missingRequiredCapabilities: 0,
          },
        },
      ],
    };

    const result = await analysisKpisJson(
      { owner: "example", name: "repo" },
      {
        summary: {
          findingCount: 0,
          highPriorityFindingCount: 0,
        },
      },
      {
        repository: {
          fullName: "example/repo",
          openIssues: 0,
          revision,
        },
      },
      {
        fetchImpl: async (url) => {
          if (url.includes("history.json")) return fileResponse(scoreHistory);
          return jsonResponse({}, 404);
        },
      },
    );

    expect(result.verification).toEqual(
      expect.objectContaining({
        status: "incomplete",
        freshness: "current",
        producerStatus: "error",
        reason: "score-production-error-tombstone",
        repositoryScore: null,
        verificationScore: null,
      }),
    );
  });

  test("publishes contract evidence before restoring a failing verification outcome", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/coverage.yml"), "utf8");
    const verification = workflow.indexOf("id: contract-verification");
    const continueOnError = workflow.indexOf("continue-on-error: true", verification);
    const publication = workflow.indexOf("name: Publish observation branch", continueOnError);
    const preserveFailure = workflow.indexOf(
      "name: Preserve public-contract verification failure",
      publication,
    );

    expect(verification).toBeGreaterThanOrEqual(0);
    expect(continueOnError).toBeGreaterThan(verification);
    expect(publication).toBeGreaterThan(continueOnError);
    expect(preserveFailure).toBeGreaterThan(publication);
    expect(workflow).toContain("if: steps.contract-verification.outcome != 'success'");
  });
});

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
