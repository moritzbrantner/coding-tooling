import { createHash } from "node:crypto";

import { analyzeProvider } from "./analysis.ts";
import type { AnalysisDiagnostic } from "./analysis-model.ts";
import {
  convergenceRuleModeForPlanning,
  scaffoldRuleId,
  validateConvergenceRulePolicy,
  type ConvergenceRuleMode,
} from "./convergence-rule-policy.ts";
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
  convergenceRules: Array<{ id: string; mode: ConvergenceRuleMode }>;
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
  const digest = createHash("sha256")
    .update([...findingIds].sort().join("\0"))
    .digest("hex");
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

function candidateFor(findings: Finding[], root?: string): RemediationCandidate {
  const ordered = [...findings].sort((left, right) => left.id.localeCompare(right.id));
  const ids = ordered.map((finding) => finding.id);
  const id = candidateId(ids);
  const allScaffoldable = ordered.every((finding) => finding.scaffold !== undefined);
  const convergenceRules = [
    ...new Map(
      ordered
        .filter((finding) => finding.scaffold !== undefined)
        .map((finding) => {
          const ruleId = scaffoldRuleId(finding.expectationId);
          return [
            ruleId,
            {
              id: ruleId,
              mode: root ? convergenceRuleModeForPlanning(root, ruleId) : ("apply" as const),
            },
          ] as const;
        }),
    ).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const automaticScaffoldable =
    allScaffoldable && convergenceRules.every((rule) => rule.mode === "apply");
  const nonInfo = ordered.some((finding) => finding.severity !== "info");
  const kind: RemediationCandidateKind = automaticScaffoldable
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
    convergenceRules,
    requiresAgent: !automaticScaffoldable,
    suggestedBranch: `remediate/${branchToken(subject.key)}-${id.slice(-6).toLowerCase()}`,
  };
}

type MobileDiagnosticMetadata = {
  category?: unknown;
  context?: unknown;
  evidence?: unknown;
};

function mobileScenarioId(diagnostic: AnalysisDiagnostic): string | undefined {
  const metadata = diagnostic.metadata as MobileDiagnosticMetadata | undefined;
  const context = metadata?.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) return undefined;
  const scenarioId = (context as Record<string, unknown>).scenarioId;
  return typeof scenarioId === "string" && scenarioId.length > 0 ? scenarioId : undefined;
}

function mobileCategory(diagnostic: AnalysisDiagnostic): string | undefined {
  const category = (diagnostic.metadata as MobileDiagnosticMetadata | undefined)?.category;
  return typeof category === "string" && category.length > 0 ? category : undefined;
}

function mobileEvidencePaths(diagnostic: AnalysisDiagnostic): string[] {
  const metadata = diagnostic.metadata as MobileDiagnosticMetadata | undefined;
  if (!Array.isArray(metadata?.evidence)) return [];
  return metadata.evidence.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const evidence = value as Record<string, unknown>;
    if (
      (evidence.kind !== "artifact" && evidence.kind !== "screenshot") ||
      typeof evidence.value !== "string" ||
      !evidence.value
    ) {
      return [];
    }
    return [`mobile-analysis-output/${evidence.value}`];
  });
}

function mobileAnalysisCandidates(root: string): RemediationCandidate[] {
  const provider = analyzeProvider(root, "mobile-analysis");
  if (!provider || provider.status !== "applied" || provider.diagnostics.length === 0) return [];

  const bySubject = new Map<string, AnalysisDiagnostic[]>();
  for (const diagnostic of provider.diagnostics) {
    const scenarioId = mobileScenarioId(diagnostic);
    const key = scenarioId ? `mobile-scenario:${scenarioId}` : `mobile-finding:${diagnostic.code}`;
    const current = bySubject.get(key) ?? [];
    current.push(diagnostic);
    bySubject.set(key, current);
  }

  return [...bySubject.entries()].map(([subjectKey, diagnostics]) => {
    const ordered = [...diagnostics].sort(
      (left, right) =>
        severityRank[left.severity] - severityRank[right.severity] ||
        left.code.localeCompare(right.code),
    );
    const ids = ordered.map((diagnostic) => diagnostic.code);
    const id = candidateId(ids);
    const scenarioId = mobileScenarioId(ordered[0]!);
    const severities = [...new Set(ordered.map((diagnostic) => diagnostic.severity))].sort(
      (left, right) => severityRank[left] - severityRank[right],
    );
    const categories = [...new Set(ordered.flatMap((diagnostic) => mobileCategory(diagnostic) ?? []))]
      .sort();
    const relatedFiles = [
      ...new Set(
        ordered.flatMap((diagnostic) => [
          ...(diagnostic.location?.path ? [diagnostic.location.path] : []),
          ...mobileEvidencePaths(diagnostic),
        ]),
      ),
      ...provider.projects,
    ].filter((value, index, all) => all.indexOf(value) === index).sort();
    const subject: Finding["subject"] = {
      kind: "repository",
      key: subjectKey,
      description: scenarioId ? `mobile scenario ${scenarioId}` : `mobile finding ${ordered[0]!.code}`,
    };
    const priority = Math.min(...ordered.map((diagnostic) => severityRank[diagnostic.severity]));
    const nonInfo = ordered.some((diagnostic) => diagnostic.severity !== "info");

    return {
      id,
      kind: nonInfo ? "implementation" : "review",
      priority,
      subject,
      summary: `Resolve mobile-analysis${categories.length > 0 ? ` ${categories.join("/")}` : ""} finding${ordered.length === 1 ? "" : "s"} for ${subject.description}`,
      findingIds: ids,
      expectationIds: ["mobile-analysis"],
      severities,
      relatedFiles,
      verification: [["coding-tooling", "analyze", "--json"]],
      scaffolds: [],
      convergenceRules: [],
      requiresAgent: true,
      suggestedBranch: `remediate/${branchToken(subject.key)}-${id.slice(-6).toLowerCase()}`,
    };
  });
}

export function planRemediationCandidates(
  findings: Finding[],
  options: { includeBaseline?: boolean; root?: string } = {},
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
  const expectationCandidates = [...bySubject.values()].map((grouped) =>
    candidateFor(grouped, options.root),
  );
  const mobileCandidates = options.root ? mobileAnalysisCandidates(options.root) : [];
  return [...expectationCandidates, ...mobileCandidates].sort(
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
  try {
    validateConvergenceRulePolicy(root);
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "remediation-plan",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, candidates: [] },
      diagnostics: [
        {
          code: "invalid-convergence-rule-policy",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

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
  const candidates = planRemediationCandidates(sourceFindings, { ...options, root });
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
        convergenceRuleModes: "disabled-suggest-apply",
      },
    },
    diagnostics: [],
  };
}
