import { describe, expect, test } from "bun:test";

import { applyHostedMergePolicy } from "../site/hosted-merge-policy.js";

describe("GitHub Pages hosted merge policy", () => {
  test("turns an opted-in hosted enforcement mismatch into a blocking finding", () => {
    const result = applyHostedMergePolicy(
      analysis(),
      declaration("hosted"),
      {
        state: "mismatch",
        branchProtected: false,
        missingDeclaredChecks: ["Pages", "Validate"],
        reason: "default-branch-unprotected",
      },
    );

    expect(result.summary).toEqual(
      expect.objectContaining({
        status: "needs-attention",
        findingCount: 1,
        highPriorityFindingCount: 1,
      }),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "REMOTE-GOVERNANCE-001",
        severity: "high",
        title: "Declared hosted merge authority is not enforced",
      }),
    ]);
  });

  test("fails closed when opted-in hosted enforcement cannot be observed", () => {
    const result = applyHostedMergePolicy(
      analysis(),
      declaration("hosted"),
      {
        state: "unavailable",
        branchProtected: null,
        missingDeclaredChecks: [],
        reason: "github-http-403",
      },
    );

    expect(result.summary).toEqual(
      expect.objectContaining({
        status: "incomplete",
        findingCount: 1,
        highPriorityFindingCount: 0,
      }),
    );
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        id: "REMOTE-GOVERNANCE-002",
        severity: "medium",
      }),
    );
    expect(result.findings[0].evidence).toContain("unavailable");
    expect(result.findings[0].evidence).not.toContain("unprotected");
  });

  test("does not create governance findings without an explicit hosted declaration", () => {
    const local = applyHostedMergePolicy(
      analysis(),
      declaration("local"),
      { state: "not-applicable", branchProtected: false },
    );
    const undeclared = applyHostedMergePolicy(
      analysis(),
      {
        state: "unavailable",
        authority: null,
        requiredChecks: [],
        reason: null,
        source: null,
        observedEnforcement: "not-evaluated",
      },
      { state: "not-applicable", branchProtected: false },
    );

    expect(local).toEqual(analysis());
    expect(undeclared).toEqual(analysis());
  });

  test("keeps aligned hosted authority clean even with extra enforced checks", () => {
    const result = applyHostedMergePolicy(
      analysis(),
      declaration("hosted"),
      {
        state: "aligned",
        branchProtected: true,
        missingDeclaredChecks: [],
        additionalEnforcedChecks: ["Security"],
        reason: "declared-checks-enforced",
      },
    );

    expect(result).toEqual(analysis());
  });

  test("treats an explicitly malformed merge authority declaration as unusable", () => {
    const result = applyHostedMergePolicy(
      analysis(),
      {
        state: "invalid",
        authority: null,
        requiredChecks: [],
        reason: "hosted-authority-requires-required-checks",
        source: ".coding-tooling.json",
        observedEnforcement: "not-evaluated",
      },
      { state: "invalid", branchProtected: true },
    );

    expect(result.summary.status).toBe("needs-attention");
    expect(result.findings[0]).toEqual(
      expect.objectContaining({ id: "REMOTE-GOVERNANCE-003", severity: "high" }),
    );
  });

  test("preserves an existing incomplete status when adding a mismatch", () => {
    const base = analysis({ status: "incomplete" });
    const result = applyHostedMergePolicy(
      base,
      declaration("hosted"),
      {
        state: "mismatch",
        branchProtected: true,
        missingDeclaredChecks: ["Validate"],
        reason: "declared-checks-not-enforced",
      },
    );

    expect(result.summary.status).toBe("incomplete");
    expect(result.summary.highPriorityFindingCount).toBe(1);
  });
});

function analysis(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: "remote-preflight",
    summary: {
      status: "ready",
      componentCount: 0,
      technologyCount: 0,
      findingCount: 0,
      highPriorityFindingCount: 0,
      ...overrides,
    },
    findings: [],
  };
}

function declaration(authority) {
  return {
    state: "declared",
    authority,
    requiredChecks: authority === "hosted" ? ["Pages", "Validate"] : [],
    reason: authority === "local" ? "Local release authority" : null,
    source: ".coding-tooling.json",
    observedEnforcement: "not-evaluated",
  };
}
