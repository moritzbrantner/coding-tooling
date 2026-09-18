import { describe, expect, test } from "bun:test";

import {
  analysisApiEnvelope,
  apiErrorEnvelope,
  coverageApiEnvelope,
  discoveryApiEnvelope,
  nextWorkApiEnvelope,
} from "../site/api-envelope.js";

describe("Pages canonical API envelope", () => {
  test("normalizes queried analysis from selection status rather than source-wide status", () => {
    const result = analysisApiEnvelope({
      schemaVersion: 1,
      operation: "remote-preflight-query",
      summary: {
        sourceStatus: "ready",
        selectionStatus: "needs-attention",
        selectedFindingCount: 1,
      },
      findings: [{ id: "REMOTE-CI-001" }],
    });

    expect(result).toEqual({
      schemaVersion: 1,
      operation: "remote-preflight-query",
      status: "failed",
      durationMs: 0,
      data: {
        summary: {
          sourceStatus: "ready",
          selectionStatus: "needs-attention",
          selectedFindingCount: 1,
        },
        findings: [{ id: "REMOTE-CI-001" }],
        evidence: {
          complete: true,
          state: "needs-attention",
        },
      },
      diagnostics: [],
    });
  });

  test("keeps unrelated source findings from failing a clean query selection", () => {
    const result = analysisApiEnvelope({
      schemaVersion: 1,
      operation: "remote-preflight-query",
      summary: { status: "needs-attention" },
      querySummary: {
        sourceStatus: "needs-attention",
        selectionStatus: "no-matching-findings",
        selectedFindingCount: 0,
      },
      findings: [],
    });

    expect(result.status).toBe("passed");
    expect(result.data.evidence).toEqual({
      complete: true,
      state: "no-matching-findings",
    });
  });

  test("keeps complete absence of coverage distinct from incomplete evidence", () => {
    const unavailable = coverageApiEnvelope({
      schemaVersion: 1,
      operation: "test-coverage-observation",
      summary: { status: "unavailable" },
      coverage: null,
    });
    const incomplete = coverageApiEnvelope({
      schemaVersion: 1,
      operation: "test-coverage-observation",
      summary: { status: "incomplete" },
      coverage: null,
    });

    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.data.evidence).toEqual({
      complete: true,
      state: "unavailable",
    });
    expect(incomplete.status).toBe("unavailable");
    expect(incomplete.data.evidence).toEqual({
      complete: false,
      state: "incomplete",
    });
  });

  test("marks bounded discovery windows explicitly without changing their domain payload", () => {
    const repositories = discoveryApiEnvelope({
      schemaVersion: 1,
      operation: "repository-discovery",
      summary: { status: "ready" },
      source: { truncated: true },
      candidates: [{ fullName: "example/repo" }],
    });
    const work = nextWorkApiEnvelope({
      schemaVersion: 1,
      operation: "next-work-discovery",
      summary: { status: "ready" },
      source: { pullsTruncated: false, issueWindowTruncated: true },
      candidates: [{ number: 1 }],
    });

    expect(repositories.status).toBe("unavailable");
    expect(repositories.data.evidence.complete).toBe(false);
    expect(work.status).toBe("unavailable");
    expect(work.data.evidence.complete).toBe(false);
  });

  test("uses the same envelope for URL and producer errors", () => {
    expect(
      apiErrorEnvelope(
        "repository-discovery",
        "invalid-discovery-url",
        "bad owner",
        { owner: "?" },
        4,
      ),
    ).toEqual({
      schemaVersion: 1,
      operation: "repository-discovery",
      status: "error",
      durationMs: 4,
      data: { owner: "?" },
      diagnostics: [{ code: "invalid-discovery-url", message: "bad owner" }],
    });
  });
});
