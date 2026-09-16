import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  AnalysisDiagnostic,
  AnalysisDiagnosticSeverity,
  AnalysisProvider,
  AnalysisProviderResult,
} from "./analysis-model.ts";
import { relativePosix } from "./shared.ts";

const providerId = "mobile-analysis";
const contractRelativePath = "mobile-analysis-output/agent-findings.json";
const findingIdPattern = /^MA-[A-F0-9]{12}$/;
const sources = new Set(["playwright", "unlighthouse", "maestro"]);
const categories = new Set([
  "interaction",
  "runtime",
  "network",
  "layout",
  "accessibility",
  "performance",
  "native",
  "tooling",
]);
const severities = new Set<AnalysisDiagnosticSeverity>(["info", "warning", "error"]);
const reproducibilities = new Set(["deterministic", "environment-dependent", "advisory"]);
const evidenceKinds = new Set(["artifact", "screenshot", "url"]);

type AgentEvidence = {
  kind: string;
  value: string;
};

type AgentFinding = {
  id: string;
  sourceFindingId: string;
  source: string;
  category: string;
  severity: AnalysisDiagnosticSeverity;
  title: string;
  details?: string;
  reproducibility: string;
  context: {
    deviceId?: string;
    scenarioId?: string;
    url?: string;
  };
  evidence: AgentEvidence[];
};

type AgentFindingsReport = {
  schemaVersion: 1;
  producer: "mobile-analysis";
  target: { name: string; baseUrl: string };
  findings: AgentFinding[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseEvidence(value: unknown, index: number, findingIndex: number): AgentEvidence {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !evidenceKinds.has(value.kind) ||
    typeof value.value !== "string" ||
    !value.value.trim()
  ) {
    throw new Error(`agent-findings.json findings[${findingIndex}].evidence[${index}] is invalid`);
  }
  return { kind: value.kind, value: value.value };
}

function parseFinding(value: unknown, index: number): AgentFinding {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !findingIdPattern.test(value.id) ||
    typeof value.sourceFindingId !== "string" ||
    !value.sourceFindingId.trim() ||
    typeof value.source !== "string" ||
    !sources.has(value.source) ||
    typeof value.category !== "string" ||
    !categories.has(value.category) ||
    typeof value.severity !== "string" ||
    !severities.has(value.severity as AnalysisDiagnosticSeverity) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !optionalString(value.details) ||
    typeof value.reproducibility !== "string" ||
    !reproducibilities.has(value.reproducibility) ||
    !isRecord(value.context) ||
    !optionalString(value.context.deviceId) ||
    !optionalString(value.context.scenarioId) ||
    !optionalString(value.context.url) ||
    !Array.isArray(value.evidence)
  ) {
    throw new Error(`agent-findings.json findings[${index}] is invalid`);
  }

  return {
    id: value.id,
    sourceFindingId: value.sourceFindingId,
    source: value.source,
    category: value.category,
    severity: value.severity as AnalysisDiagnosticSeverity,
    title: value.title,
    ...(typeof value.details === "string" ? { details: value.details } : {}),
    reproducibility: value.reproducibility,
    context: {
      ...(typeof value.context.deviceId === "string" ? { deviceId: value.context.deviceId } : {}),
      ...(typeof value.context.scenarioId === "string"
        ? { scenarioId: value.context.scenarioId }
        : {}),
      ...(typeof value.context.url === "string" ? { url: value.context.url } : {}),
    },
    evidence: value.evidence.map((item, evidenceIndex) =>
      parseEvidence(item, evidenceIndex, index),
    ),
  };
}

function readContract(path: string): AgentFindingsReport {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.producer !== "mobile-analysis" ||
    !isRecord(value.target) ||
    typeof value.target.name !== "string" ||
    typeof value.target.baseUrl !== "string" ||
    !Array.isArray(value.findings)
  ) {
    throw new Error(
      "agent-findings.json must use the mobile-analysis agent findings schemaVersion 1 contract",
    );
  }
  return {
    schemaVersion: 1,
    producer: "mobile-analysis",
    target: { name: value.target.name, baseUrl: value.target.baseUrl },
    findings: value.findings.map(parseFinding),
  };
}

function localEvidencePath(
  root: string,
  contractPath: string,
  finding: AgentFinding,
): string | undefined {
  const local = finding.evidence.find((evidence) => evidence.kind !== "url");
  return local ? relativePosix(root, join(dirname(contractPath), local.value)) : undefined;
}

function diagnostic(root: string, contractPath: string, finding: AgentFinding): AnalysisDiagnostic {
  const evidencePath = localEvidencePath(root, contractPath, finding);
  return {
    provider: providerId,
    code: finding.id,
    severity: finding.severity,
    message: finding.details ? `${finding.title}: ${finding.details}` : finding.title,
    project: relativePosix(root, contractPath),
    ...(evidencePath ? { location: { path: evidencePath } } : {}),
    metadata: {
      sourceFindingId: finding.sourceFindingId,
      source: finding.source,
      category: finding.category,
      reproducibility: finding.reproducibility,
      context: finding.context,
      evidence: finding.evidence,
    },
  };
}

export const mobileAnalysisProvider: AnalysisProvider = {
  id: providerId,
  analyze(root: string): AnalysisProviderResult {
    const contractPath = join(root, contractRelativePath);
    if (!existsSync(contractPath)) {
      return {
        id: providerId,
        displayName: "mobile-analysis evidence",
        status: "not-applicable",
        capabilities: ["diagnostics"],
        projects: [],
        diagnostics: [],
        actions: [],
        reason: `${contractRelativePath} was not found`,
      };
    }

    const report = readContract(contractPath);
    return {
      id: providerId,
      displayName: "mobile-analysis evidence",
      version: `agent-findings/v${report.schemaVersion}`,
      status: "applied",
      capabilities: ["diagnostics"],
      projects: [relativePosix(root, contractPath)],
      diagnostics: report.findings
        .map((finding) => diagnostic(root, contractPath, finding))
        .sort(
          (left, right) =>
            left.severity.localeCompare(right.severity) ||
            left.code.localeCompare(right.code) ||
            left.message.localeCompare(right.message),
        ),
      actions: [],
    };
  },
};
