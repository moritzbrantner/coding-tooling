import type { MergeReadiness } from "./merge-readiness.ts";

export type PullRequestCheckState = "passed" | "pending" | "failed";

export type PullRequestCheckEvidence = {
  name: string;
  state: PullRequestCheckState;
};

export type RepositoryMergeGate = {
  readiness: MergeReadiness;
  requiredChecks: string[];
};

export type PullRequestMergeEvidence = {
  expectedHeadSha?: string;
  currentHeadSha?: string;
  expectedBaseSha?: string;
  currentBaseSha?: string;
  mergeable?: boolean;
  checks?: PullRequestCheckEvidence[];
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  unresolvedBlockingThreads?: number;
  stackBlocked?: boolean;
  changesIntegrationPolicy?: boolean;
};

export type PullRequestMergeEligibility = {
  eligible: boolean;
  blockers: string[];
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function evaluatePullRequestMergeEligibility(
  repository: RepositoryMergeGate,
  pullRequest: PullRequestMergeEvidence,
): PullRequestMergeEligibility {
  const blockers: string[] = [];
  const requiredChecks = uniqueSorted(repository.requiredChecks);

  if (repository.readiness !== "trusted-auto-merge") {
    blockers.push(`repository-readiness:${repository.readiness}`);
  }
  if (requiredChecks.length === 0) blockers.push("required-checks-empty");

  if (!pullRequest.expectedHeadSha || !pullRequest.currentHeadSha) {
    blockers.push("head-evidence-missing");
  } else if (pullRequest.expectedHeadSha !== pullRequest.currentHeadSha) {
    blockers.push("head-moved");
  }

  if (!pullRequest.expectedBaseSha || !pullRequest.currentBaseSha) {
    blockers.push("base-evidence-missing");
  } else if (pullRequest.expectedBaseSha !== pullRequest.currentBaseSha) {
    blockers.push("base-moved");
  }

  if (pullRequest.mergeable === undefined) blockers.push("mergeability-evidence-missing");
  else if (!pullRequest.mergeable) blockers.push("pull-request-not-mergeable");

  if (pullRequest.checks === undefined) {
    blockers.push("check-evidence-missing");
  } else {
    if (pullRequest.checks.length === 0) blockers.push("attached-checks-empty");

    const checkNames = new Set<string>();
    const checkCounts = new Map<string, number>();
    for (const check of pullRequest.checks) {
      const name = check.name.trim();
      if (!name) {
        blockers.push("check-name-empty");
        continue;
      }
      checkNames.add(name);
      checkCounts.set(name, (checkCounts.get(name) ?? 0) + 1);
      if (check.state === "pending") blockers.push(`check-pending:${name}`);
      if (check.state === "failed") blockers.push(`check-failed:${name}`);
    }

    for (const [name, count] of checkCounts) {
      if (count > 1) blockers.push(`check-evidence-duplicate:${name}`);
    }
    for (const requiredCheck of requiredChecks) {
      if (!checkNames.has(requiredCheck)) blockers.push(`required-check-missing:${requiredCheck}`);
    }
  }

  if (pullRequest.reviewDecision === undefined) {
    blockers.push("review-evidence-missing");
  } else if (
    pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
    pullRequest.reviewDecision === "REVIEW_REQUIRED"
  ) {
    blockers.push(`review-blocks-merge:${pullRequest.reviewDecision.toLowerCase()}`);
  }

  if (pullRequest.unresolvedBlockingThreads === undefined) {
    blockers.push("review-thread-evidence-missing");
  } else if (
    !Number.isInteger(pullRequest.unresolvedBlockingThreads) ||
    pullRequest.unresolvedBlockingThreads < 0
  ) {
    blockers.push("review-thread-evidence-invalid");
  } else if (pullRequest.unresolvedBlockingThreads > 0) {
    blockers.push("blocking-review-threads");
  }

  if (pullRequest.stackBlocked === undefined) blockers.push("stack-evidence-missing");
  else if (pullRequest.stackBlocked) blockers.push("stack-dependency-blocked");

  if (pullRequest.changesIntegrationPolicy === undefined) {
    blockers.push("policy-change-evidence-missing");
  } else if (pullRequest.changesIntegrationPolicy) {
    blockers.push("integration-policy-change");
  }

  const normalized = uniqueSorted(blockers);
  return { eligible: normalized.length === 0, blockers: normalized };
}
