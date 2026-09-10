import { describe, expect, test } from "bun:test";

import { analysisJson } from "../site/github-analysis.js";
import {
  declaredMergeAuthorityEvidence,
  mergeAuthorityConsistency,
} from "../site/merge-authority-evidence.js";

describe("GitHub Pages merge authority consistency", () => {
  test("accepts additional enforced checks when every declared hosted check is enforced", () => {
    const declaration = declaredMergeAuthorityEvidence({
      merge: { authority: "hosted", requiredChecks: ["Validate", "Pages", "Validate"] },
    });
    const result = mergeAuthorityConsistency(
      declaration,
      protectedBranch(["Pages", "Security", "Validate"]),
    );

    expect(declaration).toEqual({
      state: "declared",
      authority: "hosted",
      requiredChecks: ["Pages", "Validate"],
      reason: null,
      source: ".coding-tooling.json",
      observedEnforcement: "not-evaluated",
    });
    expect(result).toEqual({
      state: "aligned",
      authority: "hosted",
      declaredRequiredChecks: ["Pages", "Validate"],
      enforcedRequiredChecks: ["Pages", "Security", "Validate"],
      missingDeclaredChecks: [],
      additionalEnforcedChecks: ["Security"],
      branchProtected: true,
      reason: "declared-checks-enforced",
    });
  });

  test("reports hosted authority as a mismatch when the default branch is unprotected", () => {
    const declaration = declaredMergeAuthorityEvidence({
      merge: { authority: "hosted", requiredChecks: ["Validate", "Pages"] },
    });
    const result = mergeAuthorityConsistency(declaration, {
      status: "observed",
      protected: false,
      requiredStatusChecks: { status: "observed", names: [] },
    });

    expect(result).toEqual({
      state: "mismatch",
      authority: "hosted",
      declaredRequiredChecks: ["Pages", "Validate"],
      enforcedRequiredChecks: [],
      missingDeclaredChecks: ["Pages", "Validate"],
      additionalEnforcedChecks: [],
      branchProtected: false,
      reason: "default-branch-unprotected",
    });
  });

  test("fails closed when enforcement cannot be observed", () => {
    const declaration = declaredMergeAuthorityEvidence({
      merge: { authority: "hosted", requiredChecks: ["Validate"] },
    });
    const result = mergeAuthorityConsistency(declaration, {
      status: "unavailable",
      protected: null,
      reason: "github-http-403",
      requiredStatusChecks: { status: "unavailable", names: null, reason: "github-http-403" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        state: "unavailable",
        branchProtected: null,
        reason: "github-http-403",
        enforcedRequiredChecks: null,
      }),
    );
  });

  test("keeps local authority outside GitHub enforcement comparison", () => {
    const declaration = declaredMergeAuthorityEvidence({
      merge: { authority: "local", reason: "Air-gapped release gate" },
    });
    const result = mergeAuthorityConsistency(declaration, protectedBranch([]));

    expect(declaration).toEqual({
      state: "declared",
      authority: "local",
      requiredChecks: [],
      reason: "Air-gapped release gate",
      source: ".coding-tooling.json",
      observedEnforcement: "not-evaluated",
    });
    expect(result).toEqual(
      expect.objectContaining({
        state: "not-applicable",
        authority: "local",
        reason: "local-authority-does-not-depend-on-github-enforcement",
      }),
    );
  });

  test("marks malformed declarations invalid instead of treating them as usable evidence", () => {
    const declaration = declaredMergeAuthorityEvidence({
      merge: { authority: "hosted", requiredChecks: [] },
    });
    const result = mergeAuthorityConsistency(declaration, protectedBranch([]));

    expect(declaration.state).toBe("invalid");
    expect(declaration.reason).toBe("hosted-authority-requires-required-checks");
    expect(result.state).toBe("invalid");
  });

  test("surfaces declared and observed authority simultaneously in remote preflight", async () => {
    const config = JSON.stringify({
      schemaVersion: 1,
      merge: { authority: "hosted", requiredChecks: ["Validate", "Pages"] },
    });
    const analysis = await analysisJson("example/repo", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(repositoryMetadata());
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({
            tree: [{ path: ".coding-tooling.json", sha: "config", type: "blob" }],
            truncated: false,
          });
        if (url === "https://api.github.com/repos/example/repo/branches/main")
          return jsonResponse({
            protected: false,
            protection: {
              required_status_checks: { contexts: [], checks: [] },
            },
          });
        if (url === "https://api.github.com/repos/example/repo/git/blobs/config")
          return jsonResponse({ encoding: "base64", content: btoa(config) });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(analysis.declaredMergeAuthority).toEqual({
      state: "declared",
      authority: "hosted",
      requiredChecks: ["Pages", "Validate"],
      reason: null,
      source: ".coding-tooling.json",
      observedEnforcement: "not-evaluated",
    });
    expect(analysis.mergeAuthorityConsistency).toEqual(
      expect.objectContaining({
        state: "mismatch",
        branchProtected: false,
        missingDeclaredChecks: ["Pages", "Validate"],
      }),
    );
    expect(analysis.repository.governance.defaultBranchProtection.protected).toBe(false);
  });
});

function protectedBranch(names) {
  return {
    status: "observed",
    protected: true,
    requiredStatusChecks: { status: "observed", names },
  };
}

function repositoryMetadata() {
  return {
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
