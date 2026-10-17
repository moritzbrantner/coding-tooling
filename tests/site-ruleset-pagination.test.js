// Regression for the PR #337 review finding: GitHub paginates branch rules
// (30 per page by default). A truncated first page must not be treated as complete
// evidence that a declared required check is absent.
import { describe, expect, test } from "bun:test";

import { analysisJson } from "../site/github-analysis.js";

const OWNER = "moritzbrantner";
const NAME = "runtime-profiler";
const API = `https://api.github.com/repos/${OWNER}/${NAME}`;
const REVISION = "f0638c1ad1c59c62d96863891d39481f6bd03f4d";
const DECLARED_CHECKS = ["verify", "Deterministic Findings / Coding Tooling Validation"];
const NEXT_LINK = `<${API}/rules/branches/main?page=2>; rel="next", <${API}/rules/branches/main?page=2>; rel="last"`;

describe("paginated branch rules", () => {
  test("a truncated first page without the declared checks is unavailable, not a mismatch", async () => {
    const analysis = await analyze({ legacyContexts: [], rulesPage: [], link: NEXT_LINK });

    expect(analysis.mergeAuthorityConsistency.state).toBe("unavailable");
    expect(analysis.mergeAuthorityConsistency.missingDeclaredChecks).toEqual([]);
    const ids = analysis.findings.map((finding) => finding.id);
    expect(ids).not.toContain("REMOTE-GOVERNANCE-001");
    expect(ids).toContain("REMOTE-GOVERNANCE-002");
    const required = analysis.repository.governance.defaultBranchProtection.requiredStatusChecks;
    expect(required.status).not.toBe("observed");
    expect(required.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "ruleset",
          status: "unavailable",
          reason: "branch-rules-paginated",
        }),
      ]),
    );
  });

  test("a truncated page that already covers every declared check still aligns", async () => {
    const analysis = await analyze({
      legacyContexts: [],
      rulesPage: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: DECLARED_CHECKS.map((context) => ({ context })),
          },
          ruleset_id: 1,
        },
      ],
      link: NEXT_LINK,
    });

    expect(analysis.mergeAuthorityConsistency.state).toBe("aligned");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("REMOTE-GOVERNANCE-001");
  });

  test("a single complete page (no next link) stays fully observed", async () => {
    const analysis = await analyze({
      legacyContexts: DECLARED_CHECKS,
      rulesPage: [],
      link: `<${API}/rules/branches/main?page=1>; rel="first"`,
    });

    expect(analysis.repository.governance.defaultBranchProtection.requiredStatusChecks.status).toBe(
      "observed",
    );
    expect(analysis.mergeAuthorityConsistency.state).toBe("aligned");
  });
});

async function analyze({ legacyContexts, rulesPage, link }) {
  const config = JSON.stringify({
    schemaVersion: 1,
    merge: { authority: "hosted", requiredChecks: DECLARED_CHECKS },
  });
  return analysisJson(`${OWNER}/${NAME}`, {
    fetchImpl: async (url) => {
      if (url === API) return jsonResponse(repositoryMetadata());
      if (url === `${API}/branches/main`)
        return jsonResponse({
          name: "main",
          commit: { sha: REVISION },
          protected: true,
          protection: {
            enabled: true,
            required_status_checks: {
              enforcement_level: legacyContexts.length ? "everyone" : "off",
              contexts: legacyContexts,
              checks: legacyContexts.map((context) => ({ context, app_id: null })),
            },
          },
        });
      if (url === `${API}/rules/branches/main`) return jsonResponse(rulesPage, 200, { link });
      if (url === `${API}/git/trees/${REVISION}?recursive=1`)
        return jsonResponse({
          tree: [{ path: ".coding-tooling.json", sha: "config", type: "blob" }],
          truncated: false,
        });
      if (url === `${API}/git/blobs/config`)
        return jsonResponse({ encoding: "base64", content: btoa(config) });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
}

function repositoryMetadata() {
  return {
    owner: { login: OWNER },
    name: NAME,
    full_name: `${OWNER}/${NAME}`,
    default_branch: "main",
    html_url: `https://github.com/${OWNER}/${NAME}`,
    description: null,
    archived: false,
    fork: false,
    stargazers_count: 0,
    open_issues_count: 0,
    license: null,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    has_pages: true,
  };
}

function jsonResponse(value, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => value,
  };
}
