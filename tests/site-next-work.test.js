import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  analyzeOpenWork,
  nextWorkJson,
  summarizeCiEvidence,
  NEXT_WORK_CANDIDATE_LIMIT,
  NEXT_WORK_CI_EVIDENCE_LIMIT,
  NEXT_WORK_CI_PULL_LIMIT,
  NEXT_WORK_ISSUE_LIMIT,
  NEXT_WORK_PULL_LIMIT,
} from "../site/next-work.js";

const now = new Date("2026-09-09T06:00:00.000Z");

describe("GitHub Pages next-work discovery", () => {
  test("prefers recent ready pull requests over otherwise recent draft work and issues", () => {
    const result = analyzeOpenWork(
      "example/repo",
      [
        pullRequest({ number: 4, title: "Ready", draft: false }),
        pullRequest({ number: 5, title: "Draft", draft: true }),
      ],
      [issue({ number: 6, title: "Issue" })],
      now,
    );

    expect(result.candidates.map((candidate) => `${candidate.kind}:${candidate.number}`)).toEqual([
      "pull-request:4",
      "pull-request:5",
      "issue:6",
    ]);
    expect(result.summary.suggestedWork).toEqual(result.candidates[0]);
    expect(result.summary.suggestedWork).not.toHaveProperty("score");
    expect(result.summary.suggestedWork.action).toBe("continue-or-review-pull-request");
  });

  test("lets a fresh issue outrank a stale pull request", () => {
    const result = analyzeOpenWork(
      "example/repo",
      [pullRequest({ number: 1, updated_at: "2025-01-01T00:00:00.000Z" })],
      [issue({ number: 2, updated_at: "2026-09-09T05:00:00.000Z" })],
      now,
    );

    expect(result.summary.suggestedWork.kind).toBe("issue");
    expect(result.summary.suggestedWork.number).toBe(2);
  });

  test("filters pull-request entries from GitHub's bounded issues window", () => {
    const result = analyzeOpenWork(
      "example/repo",
      [pullRequest({ number: 8 })],
      [
        issue({ number: 8, pull_request: { url: "https://api.github.com/pulls/8" } }),
        issue({ number: 9 }),
      ],
      now,
    );

    expect(result.candidates.map((candidate) => `${candidate.kind}:${candidate.number}`)).toEqual([
      "pull-request:8",
      "issue:9",
    ]);
    expect(result.source.issueWindowSemantics).toContain("includes pull requests");
  });

  test("keeps candidate output bounded and reports possibly truncated source windows", () => {
    const pulls = Array.from({ length: NEXT_WORK_PULL_LIMIT }, (_, index) =>
      pullRequest({ number: index + 1 }),
    );
    const issues = Array.from({ length: NEXT_WORK_ISSUE_LIMIT }, (_, index) =>
      issue({ number: index + 101 }),
    );
    const result = analyzeOpenWork("example/repo", pulls, issues, now);

    expect(result.candidates).toHaveLength(NEXT_WORK_CANDIDATE_LIMIT);
    expect(result.source.pullsTruncated).toBe(true);
    expect(result.source.issueWindowTruncated).toBe(true);
    expect(result.ranking.semanticPriority).toBe("not-inferred");
    expect(result.ranking.ciHealth).toBe("not-inspected");
    expect(result.ranking.ciAffectsRanking).toBe(false);
  });

  test("loads bounded open work and CI evidence through anonymous GitHub requests", async () => {
    const requests = [];
    const result = await nextWorkJson("example/repo", {
      now,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.includes("/pulls?")) return jsonResponse([pullRequest({ number: 10 })]);
        if (url.includes("/issues?")) return jsonResponse([issue({ number: 11 })]);
        if (url.includes("/check-suites?"))
          return jsonResponse({
            total_count: 1,
            check_suites: [{ status: "completed", conclusion: "success" }],
          });
        if (url.includes("/status?")) return jsonResponse({ statuses: [{ state: "success" }] });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.github.com/repos/example/repo/pulls?state=open&sort=updated&direction=desc&per_page=20",
      "https://api.github.com/repos/example/repo/issues?state=open&sort=updated&direction=desc&per_page=20",
      "https://api.github.com/repos/example/repo/commits/head-10/check-suites?per_page=100",
      "https://api.github.com/repos/example/repo/commits/head-10/status?per_page=100",
    ]);
    expect(
      requests.every(({ options }) => options.headers.Accept === "application/vnd.github+json"),
    ).toBe(true);
    expect(result.summary.status).toBe("ready");
    expect(result.candidates[0].ci.status).toBe("passing");
    expect(result.candidates[0].ci.exactHeadSha).toBe("head-10");
    expect(result.candidates[0].ci.requiredness).toBe("not-inspected");
    expect(result.ranking.ciHealth).toBe("inspected-for-top-pull-requests");
  });

  test("limits CI inspection to the highest-ranked pull requests", async () => {
    const ciRequests = [];
    await nextWorkJson("example/repo", {
      now,
      fetchImpl: async (url) => {
        if (url.includes("/pulls?"))
          return jsonResponse([
            pullRequest({ number: 1 }),
            pullRequest({ number: 2 }),
            pullRequest({ number: 3 }),
          ]);
        if (url.includes("/issues?")) return jsonResponse([]);
        ciRequests.push(url);
        if (url.includes("/check-suites?"))
          return jsonResponse({ total_count: 0, check_suites: [] });
        return jsonResponse({ statuses: [] });
      },
    });

    expect(ciRequests).toHaveLength(NEXT_WORK_CI_PULL_LIMIT * 2);
    expect(ciRequests.some((url) => url.includes("head-3"))).toBe(false);
  });

  test("keeps missing, failing, pending, and truncated CI evidence non-green", () => {
    expect(summarizeCiEvidence({ total_count: 0, check_suites: [] }, { statuses: [] }).status).toBe(
      "missing",
    );
    expect(
      summarizeCiEvidence(
        { total_count: 1, check_suites: [{ status: "completed", conclusion: "failure" }] },
        { statuses: [] },
      ).status,
    ).toBe("failing");
    expect(
      summarizeCiEvidence(
        { total_count: 1, check_suites: [{ status: "in_progress", conclusion: null }] },
        { statuses: [] },
      ).status,
    ).toBe("pending");
    expect(
      summarizeCiEvidence(
        {
          total_count: NEXT_WORK_CI_EVIDENCE_LIMIT + 1,
          check_suites: Array.from({ length: NEXT_WORK_CI_EVIDENCE_LIMIT }, () => ({
            status: "completed",
            conclusion: "success",
          })),
        },
        { statuses: [] },
      ).status,
    ).toBe("incomplete");
  });

  test("does not fail open when CI evidence cannot be loaded", async () => {
    const result = await nextWorkJson("example/repo", {
      now,
      fetchImpl: async (url) => {
        if (url.includes("/pulls?")) return jsonResponse([pullRequest({ number: 10 })]);
        if (url.includes("/issues?")) return jsonResponse([]);
        return jsonResponse({}, 403);
      },
    });

    expect(result.candidates[0].ci.status).toBe("unavailable");
    expect(result.candidates[0].ci.reason).toBe("github-http-403");
  });

  test("reports anonymous rate limiting without suggesting authentication", async () => {
    expect(
      nextWorkJson("example/repo", {
        fetchImpl: async () => ({ ok: false, status: 403 }),
      }),
    ).rejects.toThrow("Next-work discovery remains token-free");
  });

  test("advertises the fail-closed open-work browser view to registry-driven agents", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../site/agent-tool.json", import.meta.url), "utf8"),
    );
    const operation = manifest.operations.find((entry) => entry.id === "next-work-discovery");

    expect(operation?.transport).toBe("browser-json-view");
    expect(operation?.hrefTemplate).toBe(
      "https://moritzbrantner.github.io/coding-tooling/next-work.json/?repo={owner}/{repository}",
    );
    expect(operation?.description).toContain("fail-closed observed CI evidence");
    expect(
      manifest.limitations.some((limitation) =>
        limitation.includes("Missing, truncated, pending, unavailable"),
      ),
    ).toBe(true);
  });
});

function pullRequest(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    number,
    title: "Pull request",
    html_url: `https://github.com/example/repo/pull/${number}`,
    head: { sha: `head-${number}` },
    updated_at: "2026-09-09T05:00:00.000Z",
    draft: false,
    user: { login: "example", type: "User" },
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    number: 2,
    title: "Issue",
    html_url: "https://github.com/example/repo/issues/2",
    updated_at: "2026-09-09T05:00:00.000Z",
    user: { login: "example", type: "User" },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
