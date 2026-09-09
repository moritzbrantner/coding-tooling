import { describe, expect, test } from "bun:test";

import {
  analysisKpisJson,
  parsePublicContractSnapshot,
} from "../site/analysis-kpis.js";
import { buildPublicContractSnapshot } from "../scripts/build-public-contract-snapshot.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("GitHub Pages analysis KPIs", () => {
  test("combines bounded checklist work with current published execution evidence", async () => {
    const coverage = {
      schemaVersion: 1,
      kind: "coding-tooling-test-coverage-snapshot",
      repository: { fullName: "example/repo", revision },
      generatedAt: "2026-09-09T10:00:00.000Z",
      producer: { id: "coding-tooling", protocolVersion: 1 },
      source: { path: "coverage/lcov.info", format: "lcov" },
      coverage: {
        lines: { covered: 80, total: 100, percent: 80 },
        statements: null,
        functions: { covered: 18, total: 20, percent: 90 },
        branches: null,
      },
    };
    const scoreHistory = {
      schemaVersion: "coding-tooling/score-history/v1",
      repository: "example/repo",
      entries: [
        {
          commit: revision,
          score: 95,
          verification: {
            score: 80,
            plannedChecks: 5,
            passedChecks: 4,
            failedChecks: 1,
            errorChecks: 0,
            blockedChecks: 0,
            missingRequiredCapabilities: 0,
          },
        },
      ],
    };
    const contractSnapshot = {
      schemaVersion: 1,
      kind: "coding-tooling-public-contract-snapshot",
      repository: { fullName: "example/repo", revision },
      generatedAt: "2026-09-09T10:00:00.000Z",
      producer: { id: "coding-tooling", protocolVersion: 1 },
      report: {
        schemaVersion: 1,
        revision,
        summary: {
          discovered: 3,
          verified: 2,
          unverified: 1,
          incompleteDiscovery: 0,
          verifiedRatio: 2 / 3,
        },
        surfaces: [
          { kind: "http-operation", status: "verified", evidence: [] },
          { kind: "http-operation", status: "unverified", evidence: [] },
          { kind: "package-export", status: "verified", evidence: [] },
        ],
      },
    };

    const result = await analysisKpisJson(
      { owner: "example", name: "repo" },
      analysis(),
      repositorySnapshot(),
      {
        fetchImpl: async (url) => {
          if (url.includes("/issues?"))
            return jsonResponse([
              issue(1, "- [x] Land seam\n- [ ] Add endpoint KPI"),
              issue(2, "No checklist here"),
            ]);
          if (url.includes("test-coverage.json")) return fileResponse(coverage);
          if (url.includes("history.json")) return fileResponse(scoreHistory);
          if (url.includes("public-contract.json")) return fileResponse(contractSnapshot);
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    expect(result.work.checklist).toEqual(
      expect.objectContaining({
        total: 2,
        completed: 1,
        remaining: 1,
        completionPercent: 50,
      }),
    );
    expect(result.testCoverage).toEqual(
      expect.objectContaining({
        status: "observed",
        freshness: "current",
        functions: { covered: 18, total: 20, uncovered: 2, percent: 90 },
      }),
    );
    expect(result.verification).toEqual(
      expect.objectContaining({
        status: "observed",
        checks: expect.objectContaining({ planned: 5, passed: 4, failed: 1 }),
      }),
    );
    expect(result.publicContracts.httpEndpoints).toEqual({
      discovered: 2,
      verified: 1,
      unverified: 1,
      verifiedRatio: 0.5,
    });
    expect(result.findings).toEqual({
      status: "observed",
      total: 3,
      highPriority: 1,
      source: "remote-preflight",
    });
  });

  test("keeps missing KPI evidence unavailable instead of converting it to zero", async () => {
    const result = await analysisKpisJson(
      { owner: "example", name: "repo" },
      analysis(),
      repositorySnapshot(),
      { fetchImpl: async () => jsonResponse({}, 404) },
    );

    expect(result.work.checklist.remaining).toBeNull();
    expect(result.testCoverage.functions).toBeNull();
    expect(result.verification.checks.passed).toBeNull();
    expect(result.publicContracts.httpEndpoints.verified).toBeNull();
    expect(result.findings.total).toBe(3);
  });

  test("rejects a public-contract observation belonging to another repository", () => {
    expect(() =>
      parsePublicContractSnapshot(
        JSON.stringify({
          schemaVersion: 1,
          kind: "coding-tooling-public-contract-snapshot",
          repository: { fullName: "other/repo", revision },
          generatedAt: "2026-09-09T10:00:00.000Z",
          report: { schemaVersion: 1, summary: {}, surfaces: [] },
        }),
        "example/repo",
      ),
    ).toThrow("public-contract-snapshot-repository-mismatch");
  });
});

describe("public-contract observation snapshot builder", () => {
  test("preserves executed public-contract evidence with exact revision provenance", () => {
    const snapshot = buildPublicContractSnapshot({
      input: {
        schemaVersion: 1,
        operation: "contract",
        status: "passed",
        data: {
          schemaVersion: 1,
          revision,
          enforcement: "observe",
          manifestPath: ".coding-tooling.contracts.json",
          summary: {
            discovered: 1,
            verified: 1,
            unverified: 0,
            incompleteDiscovery: 0,
            failedEvidence: 0,
            unavailableEvidence: 0,
            errorEvidence: 0,
            verifiedRatio: 1,
            strictReady: true,
          },
          surfaces: [
            {
              id: "http-operation:GET:%2Fhealth",
              kind: "http-operation",
              component: ".",
              subject: "GET /health",
              discovery: { status: "complete" },
              status: "verified",
              evidence: [
                {
                  id: "health",
                  surface: "http-operation:GET:%2Fhealth",
                  kind: "behavioral",
                  capability: "test:integration",
                  component: ".",
                  outcome: "passed",
                },
              ],
            },
          ],
          unsupportedAnalyzers: [],
        },
      },
      repository: "example/repo",
      revision,
      generatedAt: "2026-09-09T10:00:00Z",
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        kind: "coding-tooling-public-contract-snapshot",
        repository: { fullName: "example/repo", revision },
        report: expect.objectContaining({ revision }),
      }),
    );
  });
});

function analysis() {
  return {
    summary: {
      findingCount: 3,
      highPriorityFindingCount: 1,
    },
  };
}

function repositorySnapshot() {
  return {
    repository: {
      fullName: "example/repo",
      openIssues: 7,
      revision,
    },
  };
}

function issue(number, body) {
  return {
    number,
    title: `Issue ${number}`,
    body,
    pull_request: undefined,
  };
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
