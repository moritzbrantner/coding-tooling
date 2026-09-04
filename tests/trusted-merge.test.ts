import { describe, expect, test } from "bun:test";

import {
  classifyTrustedMergeReadiness,
  evaluateUnattendedMergeCandidate,
  type RepositoryMergeReadiness,
} from "../src/trusted-merge.ts";

function trustedRepository(): RepositoryMergeReadiness {
  return {
    classification: "trusted-auto-merge",
    blockers: [],
    requiredChecks: ["Validate"],
  };
}

describe("trusted merge repository readiness", () => {
  test("fails closed when deterministic foundation is not ready", () => {
    const result = classifyTrustedMergeReadiness({
      foundationReady: false,
      hostedValidation: "verified",
      protectedDefaultBranch: "verified",
      requiredChecks: ["Validate"],
    });

    expect(result).toEqual({
      classification: "not-ready",
      blockers: ["foundation-not-ready"],
      requiredChecks: ["Validate"],
    });
  });

  test("fails closed when hosted validation is missing or unverified", () => {
    expect(
      classifyTrustedMergeReadiness({
        foundationReady: true,
        hostedValidation: "missing",
        protectedDefaultBranch: "verified",
        requiredChecks: ["Validate"],
      }).classification,
    ).toBe("not-ready");
    expect(
      classifyTrustedMergeReadiness({
        foundationReady: true,
        hostedValidation: "unknown",
        protectedDefaultBranch: "verified",
        requiredChecks: ["Validate"],
      }).blockers,
    ).toContain("hosted-validation-unverified");
  });

  test("keeps source-development and hardware evidence on the stronger local path", () => {
    const result = classifyTrustedMergeReadiness({
      foundationReady: true,
      localGateReasons: ["source-development", "hardware"],
      hostedValidation: "unknown",
      protectedDefaultBranch: "unknown",
      requiredChecks: null,
    });

    expect(result.classification).toBe("local-gated");
    expect(result.blockers).toEqual(["local-gate:hardware", "local-gate:source-development"]);
  });

  test("requires verified branch protection and nonzero required checks", () => {
    const unknownProtection = classifyTrustedMergeReadiness({
      foundationReady: true,
      hostedValidation: "verified",
      protectedDefaultBranch: "unknown",
      requiredChecks: ["Validate"],
    });
    const zeroChecks = classifyTrustedMergeReadiness({
      foundationReady: true,
      hostedValidation: "verified",
      protectedDefaultBranch: "verified",
      requiredChecks: [],
    });

    expect(unknownProtection.classification).toBe("protection-required");
    expect(unknownProtection.blockers).toContain("branch-protection-unverified");
    expect(zeroChecks.classification).toBe("protection-required");
    expect(zeroChecks.blockers).toContain("required-checks-empty");
  });

  test("graduates only fully evidenced repositories", () => {
    const result = classifyTrustedMergeReadiness({
      foundationReady: true,
      hostedValidation: "verified",
      protectedDefaultBranch: "verified",
      requiredChecks: ["Validate", "Cross-platform / windows-latest", "Validate"],
    });

    expect(result).toEqual({
      classification: "trusted-auto-merge",
      blockers: [],
      requiredChecks: ["Cross-platform / windows-latest", "Validate"],
    });
  });
});

describe("unattended merge candidate eligibility", () => {
  test("rejects zero attached checks even for a trusted repository", () => {
    const result = evaluateUnattendedMergeCandidate(trustedRepository(), {
      expectedHeadSha: "head",
      currentHeadSha: "head",
      expectedBaseSha: "base",
      currentBaseSha: "base",
      mergeable: true,
      attachedChecks: 0,
      passedChecks: [],
      pendingChecks: [],
      failedChecks: [],
      reviewDecision: null,
      unresolvedBlockingThreads: 0,
      stackBlocked: false,
      changesIntegrationPolicy: false,
    });

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("attached-checks-empty");
  });

  test("rejects a green check set that omits a required check", () => {
    const result = evaluateUnattendedMergeCandidate(trustedRepository(), {
      expectedHeadSha: "head",
      currentHeadSha: "head",
      expectedBaseSha: "base",
      currentBaseSha: "base",
      mergeable: true,
      attachedChecks: 1,
      passedChecks: ["Pages"],
      pendingChecks: [],
      failedChecks: [],
      reviewDecision: null,
      unresolvedBlockingThreads: 0,
      stackBlocked: false,
      changesIntegrationPolicy: false,
    });

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("required-check-missing:Validate");
  });

  test("rejects stale heads, stale bases, review blockers, stacks, and policy changes", () => {
    const result = evaluateUnattendedMergeCandidate(trustedRepository(), {
      expectedHeadSha: "old-head",
      currentHeadSha: "new-head",
      expectedBaseSha: "old-base",
      currentBaseSha: "new-base",
      mergeable: false,
      attachedChecks: 3,
      passedChecks: ["Validate"],
      pendingChecks: ["macOS"],
      failedChecks: ["Windows"],
      reviewDecision: "CHANGES_REQUESTED",
      unresolvedBlockingThreads: 1,
      stackBlocked: true,
      changesIntegrationPolicy: true,
    });

    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual([
      "base-moved",
      "blocking-review-threads",
      "check-failed:Windows",
      "check-pending:macOS",
      "head-moved",
      "integration-policy-change",
      "pull-request-not-mergeable",
      "review-blocks-merge:changes_requested",
      "stack-dependency-blocked",
    ]);
  });

  test("fails closed when PR evidence is incomplete", () => {
    const result = evaluateUnattendedMergeCandidate(trustedRepository(), {
      expectedHeadSha: "head",
      currentHeadSha: "head",
      expectedBaseSha: "base",
      currentBaseSha: "base",
    });

    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "attached-check-count-unverified",
        "check-status-evidence-incomplete",
        "mergeability-evidence-missing",
        "policy-change-evidence-missing",
        "review-evidence-missing",
        "review-thread-evidence-missing",
        "stack-evidence-missing",
      ]),
    );
  });

  test("accepts an exact-head fully-green candidate", () => {
    const result = evaluateUnattendedMergeCandidate(trustedRepository(), {
      expectedHeadSha: "head",
      currentHeadSha: "head",
      expectedBaseSha: "base",
      currentBaseSha: "base",
      mergeable: true,
      attachedChecks: 3,
      passedChecks: ["Validate", "macOS", "Windows"],
      pendingChecks: [],
      failedChecks: [],
      reviewDecision: "APPROVED",
      unresolvedBlockingThreads: 0,
      stackBlocked: false,
      changesIntegrationPolicy: false,
    });

    expect(result).toEqual({ eligible: true, blockers: [] });
  });
});
