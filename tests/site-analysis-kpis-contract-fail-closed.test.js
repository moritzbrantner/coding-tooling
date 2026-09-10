import { describe, expect, test } from "bun:test";

import { analysisKpisJson, parsePublicContractSnapshot } from "../site/analysis-kpis.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("public-contract KPI completeness", () => {
  test("rejects a current snapshot whose surface list is malformed", () => {
    expect(() =>
      parsePublicContractSnapshot(
        JSON.stringify({
          schemaVersion: 1,
          kind: "coding-tooling-public-contract-snapshot",
          repository: { fullName: "example/repo", revision },
          generatedAt: "2026-09-09T10:00:00.000Z",
          report: {
            schemaVersion: 1,
            revision,
            summary: {
              discovered: 0,
              verified: 0,
              unverified: 0,
              incompleteDiscovery: 0,
              verifiedRatio: null,
            },
            surfaces: null,
          },
        }),
        "example/repo",
      ),
    ).toThrow("public-contract-report-invalid");
  });

  test("marks current partial discovery incomplete instead of fully observed", async () => {
    const publicContracts = {
      schemaVersion: 1,
      kind: "coding-tooling-public-contract-snapshot",
      repository: { fullName: "example/repo", revision },
      generatedAt: "2026-09-09T10:00:00.000Z",
      report: {
        schemaVersion: 1,
        revision,
        summary: {
          discovered: 2,
          verified: 2,
          unverified: 0,
          incompleteDiscovery: 1,
          verifiedRatio: 1,
        },
        surfaces: [
          { kind: "http-operation", status: "verified", evidence: [] },
          { kind: "rust-crate", status: "verified", evidence: [] },
        ],
      },
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
          if (url.includes("public-contract.json")) return fileResponse(publicContracts);
          return jsonResponse({}, 404);
        },
      },
    );

    expect(result.publicContracts).toEqual(
      expect.objectContaining({
        status: "incomplete",
        freshness: "current",
        reason: "public-contract-discovery-partial",
        contracts: expect.objectContaining({
          discovered: 2,
          verified: 2,
          incompleteDiscovery: 1,
        }),
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
