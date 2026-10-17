// Acceptance for moritzbrantner/coding-tooling#325: the GitHub Pages merge-authority
// analysis must count required status checks enforced by active branch rulesets, not
// only legacy branch protection.
//
// Pinned seam (minimal, observable through the public `analysisJson` entry with a
// mocked anonymous fetch):
// - Endpoint: `GET https://api.github.com/repos/{owner}/{repo}/rules/branches/{default_branch}`
//   (GitHub's "rules for a branch" API; returns an array of active rules, of which
//   `type: "required_status_checks"` items carry
//   `parameters.required_status_checks[].context`, plus `ruleset_id`,
//   `ruleset_source_type`, `ruleset_source`).
// - Observed evidence lives at
//   `analysis.repository.governance.defaultBranchProtection.requiredStatusChecks`:
//   `names` is the sorted union of legacy branch-protection and ruleset check names,
//   and `sources` is an array of provenance entries. Each entry has a `source`
//   string containing "ruleset" (ruleset entries also carry the numeric `rulesetId`)
//   or "branch-protection" (legacy `protection.required_status_checks`), and the
//   `names` contributed by that source. Additional fields are allowed.
// - When ruleset evidence is unreadable and the observed legacy evidence does not
//   already establish every declared check, consistency is `unavailable` (fail closed,
//   REMOTE-GOVERNANCE-002), never a false `mismatch` / REMOTE-GOVERNANCE-001.
// - `analysis.declaredMergeAuthority` stays the repository declaration only
//   (`observedEnforcement: "not-evaluated"`), independent of observed rules.
import { describe, expect, test } from "bun:test";

import { analysisJson } from "../site/github-analysis.js";

const OWNER = "moritzbrantner";
const NAME = "runtime-profiler";
const API = `https://api.github.com/repos/${OWNER}/${NAME}`;
const REVISION = "f0638c1ad1c59c62d96863891d39481f6bd03f4d";
const RULESET_ID = 24414051;
const DECLARED_CHECKS = [
  "verify",
  "Deterministic Findings / Coding Tooling Validation",
  "Coding Tooling Fast / Coding Tooling Validation",
];
const SORTED_DECLARED_CHECKS = DECLARED_CHECKS.toSorted();

describe("Pages merge authority with ruleset-enforced required checks (#325)", () => {
  test("ruleset-only enforcement aligns runtime-profiler without REMOTE-GOVERNANCE-001", async () => {
    const { analysis, requests } = await analyze({ rules: runtimeProfilerRules() });

    expect(requests).toContain(`${API}/rules/branches/main`);
    expect(analysis.mergeAuthorityConsistency).toEqual(
      expect.objectContaining({
        state: "aligned",
        authority: "hosted",
        declaredRequiredChecks: SORTED_DECLARED_CHECKS,
        enforcedRequiredChecks: SORTED_DECLARED_CHECKS,
        missingDeclaredChecks: [],
        branchProtected: true,
      }),
    );
    expect(findingIds(analysis)).not.toContain("REMOTE-GOVERNANCE-001");
    expect(findingIds(analysis)).not.toContain("REMOTE-GOVERNANCE-002");

    const required = analysis.repository.governance.defaultBranchProtection.requiredStatusChecks;
    expect(required.status).toBe("observed");
    expect(required.names).toEqual(SORTED_DECLARED_CHECKS);
    expect(required.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.stringMatching(/ruleset/),
          rulesetId: RULESET_ID,
          names: expect.arrayContaining(DECLARED_CHECKS),
        }),
      ]),
    );
    const legacySources = required.sources.filter((entry) =>
      /branch-protection/.test(entry.source),
    );
    for (const entry of legacySources) expect(entry.names ?? []).toEqual([]);
  });

  test("legacy branch-protection and ruleset checks are unioned with provenance per source", async () => {
    const { analysis } = await analyze({
      legacyContexts: ["verify"],
      rules: [
        requiredStatusChecksRule([
          "Deterministic Findings / Coding Tooling Validation",
          "Coding Tooling Fast / Coding Tooling Validation",
        ]),
      ],
    });

    expect(analysis.mergeAuthorityConsistency).toEqual(
      expect.objectContaining({
        state: "aligned",
        enforcedRequiredChecks: SORTED_DECLARED_CHECKS,
        missingDeclaredChecks: [],
      }),
    );
    expect(findingIds(analysis)).not.toContain("REMOTE-GOVERNANCE-001");

    const required = analysis.repository.governance.defaultBranchProtection.requiredStatusChecks;
    expect(required.names).toEqual(SORTED_DECLARED_CHECKS);
    expect(required.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.stringMatching(/branch-protection/),
          names: ["verify"],
        }),
        expect.objectContaining({
          source: expect.stringMatching(/ruleset/),
          rulesetId: RULESET_ID,
          names: expect.arrayContaining([
            "Deterministic Findings / Coding Tooling Validation",
            "Coding Tooling Fast / Coding Tooling Validation",
          ]),
        }),
      ]),
    );
  });

  test("a declared check missing from both rulesets and legacy protection stays a mismatch", async () => {
    const { analysis } = await analyze({
      rules: [
        requiredStatusChecksRule(["verify", "Deterministic Findings / Coding Tooling Validation"]),
      ],
    });

    expect(analysis.mergeAuthorityConsistency).toEqual(
      expect.objectContaining({
        state: "mismatch",
        reason: "declared-checks-not-enforced",
        branchProtected: true,
        enforcedRequiredChecks: ["Deterministic Findings / Coding Tooling Validation", "verify"],
        missingDeclaredChecks: ["Coding Tooling Fast / Coding Tooling Validation"],
      }),
    );
    const finding = analysis.findings.find((entry) => entry.id === "REMOTE-GOVERNANCE-001");
    expect(finding).toEqual(expect.objectContaining({ severity: "high" }));
    expect(finding.evidence).toContain("Coding Tooling Fast / Coding Tooling Validation");
    expect(finding.evidence).not.toContain("Deterministic Findings");
  });

  for (const [label, rules] of [
    ["HTTP 403", { status: 403 }],
    ["HTTP 404", { status: 404 }],
    ["a network failure", { networkError: true }],
  ]) {
    test(`unreadable ruleset evidence (${label}) reports unavailable, not a false mismatch`, async () => {
      const { analysis } = await analyze({ rules });

      expect(analysis.mergeAuthorityConsistency.state).toBe("unavailable");
      expect(analysis.mergeAuthorityConsistency.missingDeclaredChecks).toEqual([]);
      expect(findingIds(analysis)).not.toContain("REMOTE-GOVERNANCE-001");
      expect(findingIds(analysis)).toContain("REMOTE-GOVERNANCE-002");
      expect(analysis.summary.status).toBe("incomplete");
      expect(
        analysis.findings.filter(
          (entry) => entry.id.startsWith("REMOTE-GOVERNANCE") && entry.severity === "high",
        ),
      ).toEqual([]);
      expect(
        analysis.repository.governance.defaultBranchProtection.requiredStatusChecks.status,
      ).not.toBe("observed");
    });
  }

  test("declared authority stays separate from observed ruleset enforcement", async () => {
    const { analysis } = await analyze({
      rules: [
        ...runtimeProfilerRules(),
        requiredStatusChecksRule(["Security"], { rulesetId: 999 }),
      ],
    });

    expect(analysis.declaredMergeAuthority).toEqual({
      state: "declared",
      authority: "hosted",
      requiredChecks: SORTED_DECLARED_CHECKS,
      reason: null,
      source: ".coding-tooling.json",
      observedEnforcement: "not-evaluated",
    });
    expect(analysis.mergeAuthorityConsistency).toEqual(
      expect.objectContaining({
        state: "aligned",
        declaredRequiredChecks: SORTED_DECLARED_CHECKS,
        enforcedRequiredChecks: [...DECLARED_CHECKS, "Security"].toSorted(),
        additionalEnforcedChecks: ["Security"],
      }),
    );
    expect(
      analysis.repository.governance.defaultBranchProtection.requiredStatusChecks.sources,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rulesetId: RULESET_ID }),
        expect.objectContaining({ rulesetId: 999, names: ["Security"] }),
      ]),
    );
  });

  test("legacy-only branch protection with no active rulesets still aligns", async () => {
    const { analysis } = await analyze({ legacyContexts: DECLARED_CHECKS, rules: [] });

    expect(analysis.mergeAuthorityConsistency).toEqual(
      expect.objectContaining({
        state: "aligned",
        enforcedRequiredChecks: SORTED_DECLARED_CHECKS,
        missingDeclaredChecks: [],
        additionalEnforcedChecks: [],
        branchProtected: true,
        reason: "declared-checks-enforced",
      }),
    );
    expect(findingIds(analysis)).not.toContain("REMOTE-GOVERNANCE-001");
    expect(analysis.repository.governance.defaultBranchProtection).toEqual(
      expect.objectContaining({
        status: "observed",
        protected: true,
        requiredStatusChecks: expect.objectContaining({
          status: "observed",
          names: SORTED_DECLARED_CHECKS,
        }),
      }),
    );
  });
});

async function analyze({ legacyContexts = [], rules }) {
  const requests = [];
  const config = JSON.stringify({
    schemaVersion: 1,
    merge: { authority: "hosted", requiredChecks: DECLARED_CHECKS },
  });
  const analysis = await analysisJson(`${OWNER}/${NAME}`, {
    fetchImpl: async (url) => {
      requests.push(url);
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
      if (url === `${API}/rules/branches/main`) {
        if (Array.isArray(rules)) return jsonResponse(rules);
        if (rules.networkError) throw new TypeError("Failed to fetch");
        return jsonResponse({ message: "denied" }, rules.status);
      }
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
  return { analysis, requests };
}

function runtimeProfilerRules() {
  return [
    {
      type: "deletion",
      ruleset_source_type: "Repository",
      ruleset_source: `${OWNER}/${NAME}`,
      ruleset_id: RULESET_ID,
    },
    {
      type: "non_fast_forward",
      ruleset_source_type: "Repository",
      ruleset_source: `${OWNER}/${NAME}`,
      ruleset_id: RULESET_ID,
    },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
      ruleset_source_type: "Repository",
      ruleset_source: `${OWNER}/${NAME}`,
      ruleset_id: RULESET_ID,
    },
    requiredStatusChecksRule(DECLARED_CHECKS),
  ];
}

function requiredStatusChecksRule(contexts, { rulesetId = RULESET_ID } = {}) {
  return {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })),
    },
    ruleset_source_type: "Repository",
    ruleset_source: `${OWNER}/${NAME}`,
    ruleset_id: rulesetId,
  };
}

function findingIds(analysis) {
  return analysis.findings.map((finding) => finding.id);
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

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
