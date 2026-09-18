import type { ExpectationRegistryRecord } from "./expectation-detectors.ts";
import type { Finding, FindingSeverity } from "./expectation-model.ts";
import { findingsCommand } from "./expectations.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { planRemediationCandidates, type RemediationCandidate } from "./remediation-plan.ts";
import { type CommandResult, runCommand } from "./shared.ts";
import { sourceRevision } from "./source-context.ts";

export const AGENT_SUMMARY_VERSION = "coding-tooling/agent-summary/v1" as const;

export type AgentSummaryDecision = "clean" | "partial" | "blocked" | "unavailable";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export type AgentEvidenceGroup = {
  subject: Finding["subject"];
  independenceKey: string;
  highestSeverity: FindingSeverity;
  findingIds: string[];
  expectationIds: string[];
  representationCount: number;
  primaryFinding: {
    id: string;
    expectationId: string;
    severity: FindingSeverity;
    message: string;
    requirement: Finding["requirement"];
    suppressionEvidence?: Finding["suppressionEvidence"];
  };
  evidence: {
    bases: string[];
    oracles: string[];
    proves: string[];
    limitations: string[];
  };
};

export type AgentNextAction = {
  id: string;
  kind: RemediationCandidate["kind"];
  summary: string;
  requiresAgent: boolean;
  findingIds: string[];
  deterministicCommands: string[][];
  verification: string[][];
  verificationDeclarations: RemediationCandidate["verificationDeclarations"];
  suppressionPolicyMatches: RemediationCandidate["suppressionPolicyMatches"];
  deferrals: Array<{ findingId: string; reason: string }>;
  fullyDeferred: boolean;
  suggestedBranch: string;
};

const severityRank: Record<FindingSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function primaryFinding(findings: Finding[]): Finding {
  return [...findings].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.expectationId.localeCompare(right.expectationId) ||
      left.id.localeCompare(right.id),
  )[0]!;
}

export function collapseAgentEvidence(
  findings: Finding[],
  registry: ExpectationRegistryRecord[],
): AgentEvidenceGroup[] {
  const byExpectation = new Map(registry.map((entry) => [entry.id, entry]));
  const grouped = new Map<string, { independenceKey: string; findings: Finding[] }>();

  for (const finding of findings) {
    const descriptor = byExpectation.get(finding.expectationId);
    const independenceKey =
      descriptor?.evidenceContract.independenceKey ?? `expectation:${finding.expectationId}`;
    const key = JSON.stringify([finding.subject.key, independenceKey]);
    const current = grouped.get(key) ?? { independenceKey, findings: [] };
    current.findings.push(finding);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map(({ independenceKey, findings: groupFindings }) => {
      const primary = primaryFinding(groupFindings);
      const descriptors = groupFindings.flatMap((finding) => {
        const descriptor = byExpectation.get(finding.expectationId);
        return descriptor ? [descriptor] : [];
      });
      return {
        subject: primary.subject,
        independenceKey,
        highestSeverity: primary.severity,
        findingIds: uniqueSorted(groupFindings.map((finding) => finding.id)),
        expectationIds: uniqueSorted(groupFindings.map((finding) => finding.expectationId)),
        representationCount: groupFindings.length,
        primaryFinding: {
          id: primary.id,
          expectationId: primary.expectationId,
          severity: primary.severity,
          message: primary.message,
          requirement: primary.requirement,
          suppressionEvidence: primary.suppressionEvidence,
        },
        evidence: {
          bases: uniqueSorted(descriptors.map((entry) => entry.evidenceContract.basis)),
          oracles: uniqueSorted(descriptors.map((entry) => entry.evidenceContract.oracle)),
          proves: uniqueSorted(descriptors.map((entry) => entry.evidenceContract.proves)),
          limitations: uniqueSorted(
            descriptors.flatMap((entry) => entry.evidenceContract.limitations),
          ),
        },
      };
    })
    .sort(
      (left, right) =>
        severityRank[left.highestSeverity] - severityRank[right.highestSeverity] ||
        left.subject.key.localeCompare(right.subject.key) ||
        left.independenceKey.localeCompare(right.independenceKey),
    );
}

function compactEvidenceGroup(group: AgentEvidenceGroup): Record<string, unknown> {
  return {
    subject: group.subject,
    independenceKey: group.independenceKey,
    highestSeverity: group.highestSeverity,
    findingIds: group.findingIds,
    expectationIds: group.expectationIds,
    representationCount: group.representationCount,
    oracles: group.evidence.oracles,
  };
}

function compactCandidate(candidate: RemediationCandidate): AgentNextAction {
  return {
    id: candidate.id,
    kind: candidate.kind,
    summary: candidate.summary,
    requiresAgent: candidate.requiresAgent,
    findingIds: candidate.findingIds,
    deterministicCommands: candidate.scaffolds.map((scaffold) => scaffold.command),
    verification: candidate.verification,
    verificationDeclarations: candidate.verificationDeclarations,
    suppressionPolicyMatches: candidate.suppressionPolicyMatches,
    deferrals: candidate.deferrals,
    fullyDeferred: candidate.fullyDeferred,
    suggestedBranch: candidate.suggestedBranch,
  };
}

function gitValue(root: string, runner: Runner, args: string[]): string | undefined {
  const result = runner("git", args, root);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function worktreeState(root: string, runner: Runner): string | undefined {
  return gitValue(root, runner, ["status", "--porcelain"]);
}

function reconciliationIssueCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (count, item) => count + (Array.isArray(item) ? item.length : 0),
    0,
  );
}

function envelope(
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "agent-summary",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function agentSummaryCommand(
  root: string,
  dependencies: { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const candidateSha = sourceRevision(root, runner);
  const initialWorktree = worktreeState(root, runner);
  if (!candidateSha || initialWorktree === undefined) {
    return envelope(
      "unavailable",
      started,
      {
        schemaVersion: AGENT_SUMMARY_VERSION,
        root,
        decision: "unavailable" satisfies AgentSummaryDecision,
      },
      [
        {
          code: "agent-summary-identity-unavailable",
          message:
            "Could not bind the summary to the caller source revision (or local Git fallback) and worktree state",
        },
      ],
    );
  }

  const findings = findingsCommand(root, { includeSuppressed: false });
  if (findings.status === "error") {
    return envelope("error", started, { root, candidateSha }, findings.diagnostics);
  }

  const sourceFindings = Array.isArray(findings.data.findings)
    ? (findings.data.findings as Finding[])
    : [];
  const registry = Array.isArray(findings.data.registry)
    ? (findings.data.registry as ExpectationRegistryRecord[])
    : [];
  const expectationReconciliation = findings.data.reconciliation ?? null;
  const expectationReconciliationIssues = reconciliationIssueCount(expectationReconciliation);
  let candidates: RemediationCandidate[];
  try {
    candidates = planRemediationCandidates(sourceFindings, { root });
  } catch (error) {
    return envelope("error", started, { root, candidateSha }, [
      {
        code: "agent-summary-remediation-planning-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  const endingSha = sourceRevision(root, runner);
  const endingWorktree = worktreeState(root, runner);
  if (endingSha !== candidateSha || endingWorktree !== initialWorktree) {
    return envelope(
      "unavailable",
      started,
      {
        schemaVersion: AGENT_SUMMARY_VERSION,
        root,
        candidateSha,
        endingSha: endingSha ?? null,
        decision: "unavailable" satisfies AgentSummaryDecision,
      },
      [
        {
          code: "agent-summary-state-moved",
          message: "Repository state changed while the summary was being produced; rerun it",
        },
      ],
    );
  }

  const activeNew = sourceFindings.filter(
    (finding) => finding.disposition === "active" && finding.state === "new",
  );
  const activeBaseline = sourceFindings.filter(
    (finding) => finding.disposition === "active" && finding.state === "baseline",
  );
  const evidenceGroups = collapseAgentEvidence(activeNew, registry);
  const hasError =
    activeNew.some((finding) => finding.severity === "error") ||
    candidates.some((candidate) => candidate.severities.includes("error"));
  const hasOutstandingWork =
    activeNew.length > 0 ||
    activeBaseline.length > 0 ||
    candidates.length > 0 ||
    expectationReconciliationIssues > 0;
  const decision: AgentSummaryDecision = hasError
    ? "blocked"
    : hasOutstandingWork
      ? "partial"
      : "clean";
  const status: ResultStatus = decision === "blocked" ? "failed" : "passed";
  const strongestEvidence = evidenceGroups[0] ?? null;
  const actionableCandidate = candidates.find((candidate) => !candidate.fullyDeferred);
  const nextAction = actionableCandidate ? compactCandidate(actionableCandidate) : null;
  const deferredActions = candidates
    .filter((candidate) => candidate.fullyDeferred)
    .map(compactCandidate);

  return envelope(status, started, {
    schemaVersion: AGENT_SUMMARY_VERSION,
    root,
    candidateSha,
    cleanWorktree: initialWorktree.length === 0,
    decision,
    counts: {
      activeNewFindings: activeNew.length,
      correlatedEvidenceGroups: evidenceGroups.length,
      collapsedRepresentations: activeNew.length - evidenceGroups.length,
      activeBaselineFindings: activeBaseline.length,
      deferredActiveFindings: sourceFindings.filter(
        (finding) => finding.disposition === "active" && finding.deferralEvidence !== undefined,
      ).length,
      newSuppressionPolicyMatches: sourceFindings.filter(
        (finding) =>
          finding.disposition === "active" &&
          finding.suppressionEvidence?.applied === false &&
          finding.suppressionEvidence.scope !== "finding",
      ).length,
      remediationCandidates: candidates.length,
      deferredRemediationCandidates: deferredActions.length,
      expectationReconciliationIssues,
    },
    strongestEvidence,
    nextAction,
    deferredActions,
    evidenceGroups: evidenceGroups.map(compactEvidenceGroup),
    drillDown: {
      strongestFinding: strongestEvidence
        ? ["coding-tooling", "finding", strongestEvidence.primaryFinding.id, "--json"]
        : null,
      findings: ["coding-tooling", "findings", "--json"],
      remediationPlan: ["coding-tooling", "remediation", "plan", "--json"],
    },
    audit: {
      findingsStatus: findings.status,
      expectationReconciliation,
      candidateSource: "existing-remediation-planner",
      note: "This summary projects existing evidence; it does not add an independent oracle.",
    },
  });
}
