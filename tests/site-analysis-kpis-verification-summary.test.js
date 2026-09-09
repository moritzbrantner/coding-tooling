import { describe, expect, test } from "bun:test";

import { analysisKpisJson } from "../site/analysis-kpis.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("verification KPI summary completeness", () => {
  test("keeps malformed and unknown verification summaries incomplete", async () => {
    for (const verification of [
      {},
      {
        status: "mystery",
        score: 100,
        plannedChecks: 1,
        passedChecks: 1,
        failedChecks: 0,
        errorChecks: 0,
        blockedChecks: 0,
        missingRequiredCapabilities: 0,
      },
      {
        status: "passed",
        score: null,
        plannedChecks: 1,
        passedChecks: 1,
        failedChecks: 0,
        errorChecks: 0,
        blockedChecks: 0,
        missingRequiredCapabilities: 0,
      },
    ]) {
      const result = await analyzeVerification(verification);

      expect(result.status).toBe("incomplete");
      expect(result.freshness).toBe("current");
      expect(result.reason).toBe("verification-summary-incomplete");
    }
  });

  test("keeps explicitly unavailable verification evidence incomplete", async () => {
    const result = await analyzeVerification({
      status: "unavailable",
      score: null,
      plannedChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      errorChecks: 0,
      blockedChecks: 0,
      missingRequiredCapabilities: 0,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "incomplete",
        producerStatus: "unavailable",
        reason: "verification-summary-unavailable",
      }),
    );
  });

  test("treats a complete failed execution as observed evidence", async () => {
    const result = await analyzeVerification({
      status: "failed",
      score: 60,
      plannedChecks: 5,
      passedChecks: 3,
      failedChecks: 2,
      errorChecks: 0,
      blockedChecks: 0,
      missingRequiredCapabilities: 0,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "observed",
        producerStatus: "failed",
        verificationScore: 60,
        reason: null,
      }),
    );
  });
});

async function analyzeVerification(verification) {
  const scoreHistory = {
    schemaVersion: "coding-tooling/score-history/v1",
    repository: "example/repo",
    entries: [
      {
        commit: revision,
        score: verification.status === "passed" || verification.status === "failed" ? 80 : null,
        verification,
      },
    ],
  };

  const result = await analysisKpisJson(
    { owner: "example", name: "repo" },
    { summary: { findingCount: 0, highPriorityFindingCount: 0 } },
    { repository: { fullName: "example/repo", openIssues: 0, revision } },
    {
      fetchImpl: async (url) => {
        if (url.includes("history.json")) return fileResponse(scoreHistory);
        return jsonResponse({}, 404);
      },
    },
  );

  return result.verification;
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
