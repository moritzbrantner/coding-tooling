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
  mergeable: boolean;
  attachedChecks: number;
  pendingChecks?: string[];
  failedChecks?: string[];
  reviewDecision?: string;
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

  if (!evidence.foundationReady) blockers.push("foundation-not-ready");
  if (evidence.hostedValidation === "missing") blockers.push("hosted-validation-missing");
  if (evidence.hostedValidation === "unknown") blockers.push("hosted-validation-unverified");

  if (blockers.length > 0) {
    return { classification: "not-ready", blockers: uniqueSorted(blockers), requiredChecks };
  }

  if (localGateReasons.length > 0) {
    return {
      classification: "local-gated",
      blockers: localGateReasons.map((reason) => `local-gate:${reason}`),
      requiredChecks,
    };
  }

  if (evidence.protectedDefaultBranch === "missing") blockers.push("branch-protection-missing");
  if (evidence.protectedDefaultBranch === "unknown")
    blockers.push("branch-protection-unverified");
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
  if (!pullRequest.mergeable) blockers.push("pull-request-not-mergeable");
  if (pullRequest.attachedChecks === 0) blockers.push("attached-checks-empty");

  for (const check of uniqueSorted(pullRequest.pendingChecks ?? [])) {
    blockers.push(`check-pending:${check}`);
  }
  for (const check of uniqueSorted(pullRequest.failedChecks ?? [])) {
    blockers.push(`check-failed:${check}`);
  }

  if (
    pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
    pullRequest.reviewDecision === "REVIEW_REQUIRED"
  )
    blockers.push(`review-blocks-merge:${pullRequest.reviewDecision.toLowerCase()}`);
  if ((pullRequest.unresolvedBlockingThreads ?? 0) > 0) blockers.push("blocking-review-threads");
  if (pullRequest.stackBlocked) blockers.push("stack-dependency-blocked");
  if (pullRequest.changesIntegrationPolicy) blockers.push("integration-policy-change");

  const normalized = uniqueSorted(blockers);
  return { eligible: normalized.length === 0, blockers: normalized };
}
