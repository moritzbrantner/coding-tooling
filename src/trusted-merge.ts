export const trustedMergeReadinesses = [
  "not-ready",
  "local-gated",
  "protection-required",
  "trusted-auto-merge",
] as const;

export type TrustedMergeReadiness = (typeof trustedMergeReadinesses)[number];
export type EvidenceState = "verified" | "missing" | "unknown";

export type RepositoryMergeEvidence = {
  foundationReady: boolean;
  localGateReasons?: string[];
  hostedValidation: EvidenceState;
  protectedDefaultBranch: EvidenceState;
  requiredChecks: string[] | null;
};

export type RepositoryMergeReadiness = {
  classification: TrustedMergeReadiness;
  blockers: string[];
  requiredChecks: string[];
};

export type PullRequestMergeEvidence = {
  expectedHeadSha?: string;
  currentHeadSha?: string;
  expectedBaseSha?: string;
  currentBaseSha?: string;
  mergeable?: boolean;
  attachedChecks?: number;
  passedChecks?: string[];
  pendingChecks?: string[];
  failedChecks?: string[];
  reviewDecision?: string | null;
  unresolvedBlockingThreads?: number;
  stackBlocked?: boolean;
  changesIntegrationPolicy?: boolean;
};

export type UnattendedMergeEligibility = {
  eligible: boolean;
  blockers: string[];
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function classifyTrustedMergeReadiness(
  evidence: RepositoryMergeEvidence,
): RepositoryMergeReadiness {
  const blockers: string[] = [];
  const localGateReasons = uniqueSorted(evidence.localGateReasons ?? []);
  const requiredChecks = uniqueSorted(evidence.requiredChecks ?? []);

  if (!evidence.foundationReady) {
    return {
      classification: "not-ready",
      blockers: ["foundation-not-ready"],
      requiredChecks,
    };
  }

  if (localGateReasons.length > 0) {
    return {
      classification: "local-gated",
      blockers: localGateReasons.map((reason) => `local-gate:${reason}`),
      requiredChecks,
    };
  }

  if (evidence.hostedValidation === "missing") blockers.push("hosted-validation-missing");
  if (evidence.hostedValidation === "unknown") blockers.push("hosted-validation-unverified");
  if (blockers.length > 0) {
    return { classification: "not-ready", blockers: uniqueSorted(blockers), requiredChecks };
  }

  if (evidence.protectedDefaultBranch === "missing") blockers.push("branch-protection-missing");
  if (evidence.protectedDefaultBranch === "unknown") blockers.push("branch-protection-unverified");
  if (evidence.requiredChecks === null) blockers.push("required-checks-unverified");
  else if (requiredChecks.length === 0) blockers.push("required-checks-empty");

  if (blockers.length > 0) {
    return {
      classification: "protection-required",
      blockers: uniqueSorted(blockers),
      requiredChecks,
    };
  }

  return { classification: "trusted-auto-merge", blockers: [], requiredChecks };
}

export function evaluateUnattendedMergeCandidate(
  repository: RepositoryMergeReadiness,
  pullRequest: PullRequestMergeEvidence,
): UnattendedMergeEligibility {
  const blockers: string[] = [];

  if (repository.classification !== "trusted-auto-merge")
    blockers.push(`repository-readiness:${repository.classification}`);
  if (!pullRequest.expectedHeadSha || !pullRequest.currentHeadSha)
    blockers.push("head-evidence-missing");
  else if (pullRequest.expectedHeadSha !== pullRequest.currentHeadSha) blockers.push("head-moved");
  if (!pullRequest.expectedBaseSha || !pullRequest.currentBaseSha)
    blockers.push("base-evidence-missing");
  else if (pullRequest.expectedBaseSha !== pullRequest.currentBaseSha) blockers.push("base-moved");

  if (pullRequest.mergeable === undefined) blockers.push("mergeability-evidence-missing");
  else if (!pullRequest.mergeable) blockers.push("pull-request-not-mergeable");

  if (!Number.isInteger(pullRequest.attachedChecks) || (pullRequest.attachedChecks ?? -1) < 0)
    blockers.push("attached-check-count-unverified");
  else if (pullRequest.attachedChecks === 0) blockers.push("attached-checks-empty");

  const checkEvidenceComplete =
    Array.isArray(pullRequest.passedChecks) &&
    Array.isArray(pullRequest.pendingChecks) &&
    Array.isArray(pullRequest.failedChecks);
  if (!checkEvidenceComplete) blockers.push("check-status-evidence-incomplete");
  const passedChecks = uniqueSorted(pullRequest.passedChecks ?? []);
  const pendingChecks = uniqueSorted(pullRequest.pendingChecks ?? []);
  const failedChecks = uniqueSorted(pullRequest.failedChecks ?? []);
  const attachedCheckNames = new Set([...passedChecks, ...pendingChecks, ...failedChecks]);

  for (const requiredCheck of repository.requiredChecks) {
    if (!attachedCheckNames.has(requiredCheck))
      blockers.push(`required-check-missing:${requiredCheck}`);
  }
  for (const check of pendingChecks) blockers.push(`check-pending:${check}`);
  for (const check of failedChecks) blockers.push(`check-failed:${check}`);

  if (pullRequest.reviewDecision === undefined) blockers.push("review-evidence-missing");
  else if (
    pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
    pullRequest.reviewDecision === "REVIEW_REQUIRED"
  )
    blockers.push(`review-blocks-merge:${pullRequest.reviewDecision.toLowerCase()}`);

  if (!Number.isInteger(pullRequest.unresolvedBlockingThreads))
    blockers.push("review-thread-evidence-missing");
  else if ((pullRequest.unresolvedBlockingThreads ?? 0) > 0)
    blockers.push("blocking-review-threads");

  if (pullRequest.stackBlocked === undefined) blockers.push("stack-evidence-missing");
  else if (pullRequest.stackBlocked) blockers.push("stack-dependency-blocked");

  if (pullRequest.changesIntegrationPolicy === undefined)
    blockers.push("policy-change-evidence-missing");
  else if (pullRequest.changesIntegrationPolicy) blockers.push("integration-policy-change");

  const normalized = uniqueSorted(blockers);
  return { eligible: normalized.length === 0, blockers: normalized };
}
