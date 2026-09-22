import { describe, expect, test } from "bun:test";

import { createGithubFetch, handleAnalysisRequest } from "../worker/analysis-worker.js";

function projectedAnalysis() {
  return {
    schemaVersion: 1,
    operation: "remote-preflight-query",
    generatedAt: "2026-09-22T00:00:00.000Z",
    repository: {
      fullName: "example/project",
      defaultBranch: "main",
      revision: "0123456789abcdef0123456789abcdef01234567",
      htmlUrl: "https://github.com/example/project",
    },
    querySummary: {
      sourceStatus: "ok",
      selectionStatus: "no-matching-findings",
      selectedFindingCount: 0,
      matchingFindingCount: 0,
      selectedComponentCount: 1,
      findingsTruncated: false,
    },
    findings: [],
    components: [],
    limitations: [],
    agentHandoff: { localCommands: [] },
  };
}

describe("analysis HTTP worker", () => {
  test("serves the existing analysis projection as real application/json", async () => {
    let observedRepository = null;
    let observedView = null;

    const response = await handleAnalysisRequest(
      new Request(
        "https://analysis.example/analysis.json?repo=example%2Fproject&view=agent&envelope=1",
      ),
      {},
      {
        analysisQueryJson: async (repository, parameters) => {
          observedRepository = repository;
          observedView = parameters.get("view");
          return projectedAnalysis();
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(observedRepository).toBe("example/project");
    expect(observedView).toBe("agent");

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        operation: "remote-preflight-query",
        status: "passed",
      }),
    );
    expect(body.data.repository.fullName).toBe("example/project");
    expect(body.data.evidence).toEqual({
      complete: true,
      state: "no-matching-findings",
    });
  });

  test("preserves the legacy raw shape when envelope is not requested", async () => {
    const response = await handleAnalysisRequest(
      new Request("https://analysis.example/analysis.json?repo=example%2Fproject&view=agent"),
      {},
      { analysisQueryJson: async () => projectedAnalysis() },
    );

    const body = await response.json();
    expect(body.operation).toBe("remote-preflight-query");
    expect(body).not.toHaveProperty("status");
    expect(body.repository.fullName).toBe("example/project");
  });

  test("fails closed with JSON for invalid requests", async () => {
    const missingRepository = await handleAnalysisRequest(
      new Request("https://analysis.example/analysis.json?envelope=1"),
    );
    expect(missingRepository.status).toBe(400);
    expect(await missingRepository.json()).toEqual(
      expect.objectContaining({
        status: "error",
        diagnostics: [
          expect.objectContaining({
            code: "invalid-analysis-url",
          }),
        ],
      }),
    );

    const wrongMethod = await handleAnalysisRequest(
      new Request("https://analysis.example/analysis.json?repo=example/project", {
        method: "POST",
      }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, OPTIONS");

    const wrongPath = await handleAnalysisRequest(
      new Request("https://analysis.example/other?repo=example/project"),
    );
    expect(wrongPath.status).toBe(404);
  });

  test("uses immutable caching only for caller-pinned commit SHAs", async () => {
    const analyze = async () => projectedAnalysis();
    const pinned = await handleAnalysisRequest(
      new Request(
        "https://analysis.example/analysis.json?repo=example/project&ref=0123456789abcdef0123456789abcdef01234567",
      ),
      {},
      { analysisQueryJson: analyze },
    );
    const branch = await handleAnalysisRequest(
      new Request("https://analysis.example/analysis.json?repo=example/project&ref=main"),
      {},
      { analysisQueryJson: analyze },
    );

    expect(pinned.headers.get("cache-control")).toContain("immutable");
    expect(branch.headers.get("cache-control")).not.toContain("immutable");
    expect(branch.headers.get("cache-control")).toContain("s-maxage=60");
  });

  test("never forwards caller credentials and adds only the worker GitHub token", async () => {
    const calls = [];
    const fetchImpl = async (input, init) => {
      calls.push({ input, headers: new Headers(init.headers) });
      return new Response("{}", { status: 200 });
    };
    const wrapped = createGithubFetch("server-token", fetchImpl);

    await wrapped("https://api.github.com/repos/example/project", {
      headers: {
        Authorization: "Bearer caller-token",
        Cookie: "session=caller-cookie",
        Accept: "application/vnd.github+json",
      },
    });
    await wrapped("https://example.com/resource", {
      headers: {
        Authorization: "Bearer caller-token",
        Cookie: "session=caller-cookie",
      },
    });

    expect(calls[0].headers.get("authorization")).toBe("Bearer server-token");
    expect(calls[0].headers.get("cookie")).toBeNull();
    expect(calls[0].headers.get("accept")).toBe("application/vnd.github+json");
    expect(calls[1].headers.get("authorization")).toBeNull();
    expect(calls[1].headers.get("cookie")).toBeNull();
  });

  test("answers CORS preflight without running analysis", async () => {
    const response = await handleAnalysisRequest(
      new Request("https://analysis.example/analysis.json", { method: "OPTIONS" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});
