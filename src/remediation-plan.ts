import { createHash } from "node:crypto";

import type { Finding, FindingSeverity } from "./expectation-model.ts";
import { findingsCommand } from "./expectations.ts";
import type { ResultStatus } from "./model.ts";

export type RemediationCandidateKind = "deterministic-scaffold" | "implementation" | "review";

export type RemediationCandidate = {
  id: string;
  kind: RemediationCandidateKind;
  priority: number;
  subject: Finding["subject"];
  summary: string;
  findingIds: string[];
  expectationIds: string[];
  severities: FindingSeverity[];
  relatedFiles: string[];
  verification: string[][];
  scaffolds: Array<{ findingId: string; path: string; command: string[] }>;
  requiresAgent: boolean;
  suggestedBranch: string;
};

export type RemediationPlanEnvelope = {
  schemaVersion: 1;
  operation: "remediation-plan";
  status: ResultStatus;
  durationMs: number;
  data: Record<string, unknown>;
  diagnostics: Array<{ code?: string; message: string }>;
};

const severityRank: Record<FindingSeverity, number> = {
  error: 0,
  warning: 10,
  info: 20,
};

function candidateId(findingIds: string[]): string {
  const digest = createHash("sha256").update(findingIds.toSorted().join("\0")).digest("hex");
  return `CT-RM-${digest.slice(0, 12).toUpperCase()}`;
}

function branchToken(value: string): string {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return token || "repository";
}

function uniqueCommands(commands: string[][]): string[][] {
  const byKey = new Map<string, string[]>();
  for (const command of commands) byKey.set(JSON.stringify(command), command);
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, command]) => command);
}

function candidateFor(findings: Finding[]): RemediationCandidate {
  const ordered = findings.toSorted((left, right) => left.id.localeCompare(right.id));
  const ids = ordered.map((finding) => finding.id);
  const id = candidateId(ids);
  const allScaffoldable = ordered.every((finding) => finding.scaffold !== undefined);
  const nonInfo = ordered.some((finding) => finding.severity !== "info");
  const kind: RemediationCandidateKind = allScaffoldable
    ? "deterministic-scaffold"
    : nonInfo
      ? "implementation"
      : "review";
  const priority = Math.min(
    ...ordered.map(
      (finding) => severityRank[finding.severity] + (finding.state === "baseline" ? 50 : 0),
    ),
  );
  const expectationIds = [...new Set(ordered.map((finding) => finding.expectationId))].sort();
  const severities = [...new Set(ordered.map((finding) => finding.severity))].sort(
    (left, right) => severityRank[left] - severityRank[right],
  );
  const relatedFiles = [
    ...new Set(
      ordered.flatMap((finding) => [
        ...finding.relatedFiles,
        ...finding.evidence.map((entry) => entry.path),
        ...(finding.scaffold ? [finding.scaffold.path] : []),
      ]),
    ),
  ].sort();
  const verification = uniqueCommands(ordered.flatMap((finding) => finding.verification));
  const scaffolds = ordered.flatMap((finding) =>
    finding.scaffold
      ? [
          {
            findingId: finding.id,
            path: finding.scaffold.path,
            command: ["coding-tooling", "scaffold", finding.id],
          },
        ]
      : [],
  );
  const subject = ordered[0]!.subject;

  return {
    id,
    kind,
    priority,
    subject,
    summary: `Resolve ${expectationIds.join(", ")} for ${subject.description}`,
    findingIds: ids,
    expectationIds,
    severities,
    relatedFiles,
    verification,
    scaffolds,
    requiresAgent: !allScaffoldable,
    suggestedBranch: `remediate/${branchToken(subject.key)}-${id.slice(-6).toLowerCase()}`,
  };
}

export function planRemediationCandidates(
  findings: Finding[],
  options: { includeBaseline?: boolean } = {},
): RemediationCandidate[] {
  const selected = findings.filter(
    (finding) =>
      finding.disposition === "active" &&
      (options.includeBaseline === true || finding.state === "new"),
  );
  const bySubject = new Map<string, Finding[]>();
  for (const finding of selected) {
    const current = bySubject.get(finding.subject.key) ?? [];
    current.push(finding);
    bySubject.set(finding.subject.key, current);
  }
  return [...bySubject.values()]
    .map(candidateFor)
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.subject.key.localeCompare(right.subject.key) ||
        left.id.localeCompare(right.id),
    );
}

export function remediationPlanCommand(
  root: string,
  options: { includeBaseline?: boolean } = {},
): RemediationPlanEnvelope {
  const started = Date.now();
  const findings = findingsCommand(root, { includeSuppressed: false });
  if (findings.status === "error") {
    return {
      schemaVersion: 1,
      operation: "remediation-plan",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, candidates: [] },
      diagnostics: findings.diagnostics,
    };
  }

  const sourceFindings = Array.isArray(findings.data.findings)
    ? (findings.data.findings as Finding[])
    : [];
  const candidates = planRemediationCandidates(sourceFindings, options);
  return {
    schemaVersion: 1,
    operation: "remediation-plan",
    status: "passed",
    durationMs: Date.now() - started,
    data: {
      root,
      includeBaseline: options.includeBaseline === true,
      sourceStatus: findings.status,
      candidateCount: candidates.length,
      candidates,
      policy: {
        mutatesRepository: false,
        automaticIssueCreation: false,
        defaultFindingState: "new",
        grouping: "subject",
      },
    },
    diagnostics: [],
  };
}
