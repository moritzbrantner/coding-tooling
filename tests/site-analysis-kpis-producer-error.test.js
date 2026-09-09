import { describe, expect, test } from "bun:test";

import { analysisKpisJson } from "../site/analysis-kpis.js";
import { buildPublicContractSnapshot } from "../scripts/build-public-contract-snapshot.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("public-contract producer error evidence", () => {
  test("preserves an error envelope and never exposes placeholder zero counts as measured KPIs", async () => {
    const snapshot = buildPublicContractSnapshot({
      input: {
        schemaVersion: 1,
        operation: "contract",
        status: "error",
        durationMs: 1,
        data: {
          schemaVersion: 1,
          revision,
          enforcement: "observe",
          manifestPath: ".coding-tooling.contracts.json",
          summary: {
            discovered: 0,
            verified: 0,
            unverified: 0,
            incompleteDiscovery: 0,
            failedEvidence: 0,
            unavailableEvidence: 0,
            errorEvidence: 0,
            verifiedRatio: null,
            strictReady: false,
          },
          surfaces: [],
          unsupportedAnalyzers: [],
        },
        diagnostics: [{ code: "invalid-public-contract", message: "bad config" }],
      },
      repository: "example/repo",
      revision,
      generatedAt: "2026-09-09T10:00:00Z",
    });

    expect(snapshot.producer).toEqual({
      id: "coding-tooling",
      protocolVersion: 1,
      status: "error",
      diagnostics: [{ code: "invalid-public-contract", message: "bad config" }],
    });

    const result = await analysisKpisJson(
      { owner: "example", name: "repo" },
      { summary: { findingCount: 0, highPriorityFindingCount: 0 } },
      { repository: { fullName: "example/repo", openIssues: 0, revision } },
      {
        fetchImpl: async (url) => {
          if (url.includes("public-contract.json")) return fileResponse(snapshot);
          return jsonResponse({}, 404);
        },
      },
    );

    expect(result.publicContracts).toEqual(
      expect.objectContaining({
        status: "incomplete",
        freshness: "current",
        producerStatus: "error",
        reason: "public-contract-producer-error",
        contracts: expect.objectContaining({ discovered: null, verified: null }),
        httpEndpoints: expect.objectContaining({ discovered: null, verified: null }),
      }),
    );
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
