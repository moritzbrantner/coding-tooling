import { describe, expect, test } from "bun:test";

import {
  evaluatePullRequestMergeEligibility,
  type PullRequestMergeEvidence,
  type RepositoryMergeGate,
} from "../src/pr-merge-eligibility.ts";

function trustedGate(requiredChecks = ["Validate"]): RepositoryMergeGate {
  return {
    readiness: "trusted-auto-merge",
    requiredChecks,
  };
}

function completeEvidence(
  overrides: Partial<PullRequestMergeEvidence> = {},
): PullRequestMergeEvidence {
  return {
    open: true,
    draft: false,
    expectedHeadSha: "head",
    currentHeadSha: "head",
    expectedBaseSha: "base",
    currentBaseSha: "base",
    mergeable: true,
    checks: [{ name: "Validate", state: "passed" }],
    reviewDecision: null,
    unresolvedBlockingThreads: 0,
    stackBlocked: false,
    changesIntegrationPolicy: false,
    ...overrides,
  };
}

describe("pull request unattended merge eligibility", () => {
  test("requires repository graduation", () => {
    const result = evaluatePullRequestMergeEligibility(
      { readiness: "local-gated", requiredChecks: ["Validate"] },
      completeEvidence(),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("repository-readiness:local-gated");
  });

  test("defends against an inconsistent trusted gate with zero required checks", () => {
    const result = evaluatePullRequestMergeEligibility(trustedGate([]), completeEvidence());

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("required-checks-empty");
  });

  test("fails closed when current PR evidence is missing", () => {
    const result = evaluatePullRequestMergeEligibility(trustedGate(), {});

    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "base-evidence-missing",
        "check-evidence-missing",
        "draft-evidence-missing",
        "head-evidence-missing",
        "mergeability-evidence-missing",
        "policy-change-evidence-missing",
        "pr-state-evidence-missing",
        "review-evidence-missing",
        "review-thread-evidence-missing",
        "stack-evidence-missing",
      ]),
    );
  });

  test("rejects closed and draft pull requests", () => {
    const closed = evaluatePullRequestMergeEligibility(
      trustedGate(),
      completeEvidence({ open: false }),
    );
    const draft = evaluatePullRequestMergeEligibility(
      trustedGate(),
      completeEvidence({ draft: true }),
    );

    expect(closed.blockers).toContain("pull-request-not-open");
    expect(draft.blockers).toContain("pull-request-is-draft");
  });

  test("rejects zero attached checks and missing required checks", () => {
    const zeroChecks = evaluatePullRequestMergeEligibility(
      trustedGate(),
      completeEvidence({ checks: [] }),
    );
    const wrongCheck = evaluatePullRequestMergeEligibility(
      trustedGate(),
      completeEvidence({ checks: [{ name: "Pages", state: "passed" }] }),
    );

    expect(zeroChecks.blockers).toContain("attached-checks-empty");
    expect(zeroChecks.blockers).toContain("required-check-missing:Validate");
    expect(wrongCheck.blockers).toContain("required-check-missing:Validate");
  });

  test("rejects ambiguous duplicate check evidence", () => {
    const result = evaluatePullRequestMergeEligibility(
      trustedGate(),
      completeEvidence({
        checks: [
          { name: "Validate", state: "failed" },
          { name: "Validate", state: "passed" },
        ],
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("check-evidence-duplicate:Validate");
    expect(result.blockers).toContain("check-failed:Validate");
  });

  test("rejects pending and failed attached checks", () => {
    const result = evaluatePullRequestMergeEligibility(
      trustedGate(["Validate", "Windows"]),
      completeEvidence({
        checks: [
          { name: "Validate", state: "pending" },
          { name: "Windows", state: "failed" },
        ],
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("check-pending:Validate");
    expect(result.blockers).toContain("check-failed:Windows");
  });

  test("rejects stale revisions, review blockers, stacks, and policy changes", () => {
    const result = evaluatePullRequestMergeEligibility(
      trustedGate(),
      completeEvidence({
        currentHeadSha: "new-head",
        currentBaseSha: "new-base",
        mergeable: false,
        reviewDecision: "CHANGES_REQUESTED",
        unresolvedBlockingThreads: 1,
        stackBlocked: true,
        changesIntegrationPolicy: true,
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "base-moved",
        "blocking-review-threads",
        "head-moved",
        "integration-policy-change",
        "pull-request-not-mergeable",
        "review-blocks-merge:changes_requested",
        "stack-dependency-blocked",
      ]),
    );
  });

  test("accepts only an exact-head fully evidenced green candidate", () => {
    const result = evaluatePullRequestMergeEligibility(trustedGate(), completeEvidence());

    expect(result).toEqual({ eligible: true, blockers: [] });
  });
});
