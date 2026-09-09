import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  analyzeRepositories,
  discoveryJson,
  DISCOVERY_CANDIDATE_LIMIT,
} from "../site/repository-discovery.js";

const now = new Date("2026-09-09T06:00:00.000Z");

describe("GitHub Pages repository discovery", () => {
  test("ranks recent owned public repositories with open work first", () => {
    const discovery = analyzeRepositories(
      "example",
      [
        repository({ name: "quiet", pushed_at: "2026-09-08T06:00:00.000Z" }),
        repository({
          name: "active",
          pushed_at: "2026-09-08T06:00:00.000Z",
          open_issues_count: 4,
        }),
        repository({
          name: "old-open",
          pushed_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
          open_issues_count: 30,
        }),
      ],
      now,
    );

    expect(discovery.summary.suggestedRepository).toBe("example/active");
    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual([
      "example/active",
      "example/quiet",
      "example/old-open",
    ]);
    expect(discovery.candidates[0].signals).toEqual([
      "recent-activity",
      "open-github-items",
      "source-repository",
    ]);
  });

  test("filters non-public, archived, disabled, and foreign repositories", () => {
    const discovery = analyzeRepositories(
      "example",
      [
        repository({ name: "kept" }),
        repository({ name: "private", private: true, visibility: "private" }),
        repository({ name: "archived", archived: true }),
        repository({ name: "disabled", disabled: true }),
        repository({ name: "foreign", owner: { login: "other" }, full_name: "other/foreign" }),
      ],
      now,
    );

    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual(["example/kept"]);
  });

  test("keeps forks eligible but prefers an otherwise equivalent source repository", () => {
    const discovery = analyzeRepositories(
      "example",
      [repository({ name: "fork", fork: true }), repository({ name: "source" })],
      now,
    );

    expect(discovery.candidates.map((entry) => entry.name)).toEqual(["source", "fork"]);
    expect(discovery.candidates[1].signals).toContain("fork");
  });

  test("keeps discovery bounded and reports when the public repository window may be truncated", () => {
    const repositories = Array.from({ length: 100 }, (_, index) =>
      repository({ name: `repo-${String(index).padStart(3, "0")}` }),
    );
    const discovery = analyzeRepositories("example", repositories, now);

    expect(discovery.candidates).toHaveLength(DISCOVERY_CANDIDATE_LIMIT);
    expect(discovery.source.truncated).toBe(true);
    expect(discovery.source.openItemSemantics).toContain("issues and pull requests");
  });

  test("loads the bounded owner repository list through the anonymous GitHub API", async () => {
    const requests = [];
    const discovery = await discoveryJson("example", {
      now,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse([repository({ name: "repo" })]);
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://api.github.com/users/example/repos?type=owner&sort=updated&direction=desc&per_page=100",
    );
    expect(requests[0].options.headers.Accept).toBe("application/vnd.github+json");
    expect(discovery.summary.suggestedRepository).toBe("example/repo");
  });

  test("reports anonymous rate limiting without suggesting a token", async () => {
    expect(
      discoveryJson("example", {
        fetchImpl: async () => ({ ok: false, status: 403 }),
      }),
    ).rejects.toThrow("Repository discovery remains token-free");
  });

  test("advertises the browser discovery view to registry-driven agents", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../site/agent-tool.json", import.meta.url), "utf8"),
    );
    const operation = manifest.operations.find((entry) => entry.id === "repository-discovery");

    expect(operation).toEqual({
      id: "repository-discovery",
      transport: "browser-json-view",
      hrefTemplate: "https://moritzbrantner.github.io/coding-tooling/discovery.json/?owner={owner}",
      description:
        "Browser-executed token-free discovery of bounded public GitHub repository metadata with a deterministic suggested repository candidate.",
    });
    expect(
      manifest.limitations.some((limitation) =>
        limitation.includes("run-json, repository-discovery, affected-json"),
      ),
    ).toBe(true);
  });
});

function repository(overrides = {}) {
  const owner = overrides.owner ?? { login: "example" };
  const name = overrides.name ?? "repo";
  return {
    name,
    full_name: overrides.full_name ?? `${owner.login}/${name}`,
    owner,
    private: false,
    visibility: "public",
    archived: false,
    disabled: false,
    fork: false,
    description: null,
    html_url: `https://github.com/${owner.login}/${name}`,
    default_branch: "main",
    language: "TypeScript",
    open_issues_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-09-08T06:00:00.000Z",
    pushed_at: "2026-09-08T06:00:00.000Z",
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
