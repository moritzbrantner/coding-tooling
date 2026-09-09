import { describe, expect, test } from "bun:test";

import {
  analysisJson,
  repositoryGovernanceEvidence,
} from "../site/github-analysis.js";

describe("GitHub Pages repository governance evidence", () => {
  test("preserves observed false and absent governance facts distinctly", () => {
    const governance = repositoryGovernanceEvidence({
      license: null,
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: false,
      allow_auto_merge: false,
      has_pages: true,
    });

    expect(governance.license).toEqual({
      status: "observed",
      present: false,
      spdxId: null,
      name: null,
    });
    expect(governance.mergeStrategies.mergeCommit).toEqual({
      status: "observed",
      value: false,
    });
    expect(governance.mergeStrategies.squash).toEqual({ status: "observed", value: true });
    expect(governance.pages).toEqual({ status: "observed", value: true });
    expect(governance.defaultBranchProtection).toEqual(
      expect.objectContaining({ status: "unavailable", protected: null }),
    );
  });

  test("keeps missing GitHub metadata unavailable rather than treating it as false", () => {
    const governance = repositoryGovernanceEvidence({});

    expect(governance.license).toEqual({
      status: "unavailable",
      value: null,
      reason: "field-not-exposed",
    });
    expect(governance.mergeStrategies.autoMerge.status).toBe("unavailable");
    expect(governance.pages.status).toBe("unavailable");
    expect(governance.defaultBranchProtection.requiredStatusChecks).toEqual({
      status: "unavailable",
      names: null,
      reason: "branch-protection-details-not-inspected",
    });
  });

  test("surfaces governance in remote preflight without another anonymous API request", async () => {
    const requests = [];
    const analysis = await analysisJson("example/repo", {
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse({
            owner: { login: "example" },
            name: "repo",
            full_name: "example/repo",
            default_branch: "main",
            html_url: "https://github.com/example/repo",
            description: null,
            archived: false,
            fork: false,
            stargazers_count: 0,
            open_issues_count: 0,
            license: { spdx_id: "MIT", name: "MIT License" },
            allow_merge_commit: false,
            allow_squash_merge: true,
            allow_rebase_merge: true,
            allow_auto_merge: false,
            has_pages: true,
          });
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({ tree: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(requests).toHaveLength(2);
    expect(analysis.repository.governance).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        license: {
          status: "observed",
          present: true,
          spdxId: "MIT",
          name: "MIT License",
        },
      }),
    );
    expect(analysis.repository.governance.mergeStrategies.squash).toEqual({
      status: "observed",
      value: true,
    });
  });
});

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
