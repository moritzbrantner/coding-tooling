import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ResultStatus } from "./model.ts";
import {
  repositoryScoreCommand as structuralRepositoryScoreCommand,
  type RepositoryAuditScore,
  type RepositoryCategoryScore,
  type RepositoryScoreCompleteness,
  type RepositoryScoreDocument as StructuralScoreDocument,
  type RepositoryScoreRating,
} from "./repository-score.ts";

export type RepositoryProgressScoreCategory = RepositoryCategoryScore["id"] | "verification";

export type RepositoryProgressCategoryScore = {
  id: RepositoryProgressScoreCategory;
  score: number;
  auditCount: number;
};

export type RepositoryVerificationScore = {
  source: "coding-tooling/run/v1";
  reportPath: string;
  status: ResultStatus;
  score: number | null;
  plannedChecks: number;
  passedChecks: number;
  failedChecks: number;
  errorChecks: number;
  blockedChecks: number;
  missingRequiredCapabilities: number;
};

export type RepositoryProgressScoreDocument = {
  schemaVersion: "coding-tooling/repository-score/v1";
  score: number | null;
  rating: RepositoryScoreRating;
  completeness: RepositoryScoreCompleteness;
  structuralScore: number | null;
  verificationScore: number | null;
  categories: RepositoryProgressCategoryScore[];
  audits: RepositoryAuditScore[];
  verification: RepositoryVerificationScore | null;
  coverage: StructuralScoreDocument["coverage"];
  findings: StructuralScoreDocument["findings"];
  notes: string[];
};

export type RepositoryProgressScoreEnvelope = {
  schemaVersion: 1;
  operation: "score";
  status: ResultStatus;
  durationMs: number;
  data: {
    root: string;
    score?: RepositoryProgressScoreDocument;
  };
  diagnostics: Array<{ code?: string; message: string; path?: string }>;
};

type ValidationCheck = {
  capability?: unknown;
  component?: unknown;
  path?: unknown;
  status?: unknown;
};

type ValidationMissing = {
  capability?: unknown;
  optional?: unknown;
};

type ValidationReport = {
  schemaVersion?: unknown;
  operation?: unknown;
  status?: unknown;
  data?: {
    root?: unknown;
    checks?: unknown;
    results?: unknown;
    missing?: unknown;
  };
};

function rating(score: number | null): RepositoryScoreRating {
  if (score === null) return "unavailable";
  if (score >= 90) return "good";
  if (score >= 50) return "needs-improvement";
  return "poor";
}

function resultStatus(value: unknown): ResultStatus | undefined {
  return value === "passed" || value === "failed" || value === "unavailable" || value === "error"
    ? value
    : undefined;
}

function validationScore(root: string, reportPath: string): RepositoryVerificationScore {
  const absoluteReport = resolve(root, reportPath);
  const parsed = JSON.parse(readFileSync(absoluteReport, "utf8")) as ValidationReport;
  if (parsed.schemaVersion !== 1 || parsed.operation !== "run") {
    throw new Error(`${reportPath} is not a coding-tooling run report`);
  }
  const status = resultStatus(parsed.status);
  if (!status) throw new Error(`${reportPath} has an invalid run status`);
  if (!parsed.data || typeof parsed.data.root !== "string") {
    throw new Error(`${reportPath} does not identify its repository root`);
  }
  if (resolve(parsed.data.root) !== resolve(root)) {
    throw new Error(`${reportPath} was produced for a different repository root`);
  }

  const checks = Array.isArray(parsed.data.checks) ? (parsed.data.checks as ValidationCheck[]) : [];
  const results = Array.isArray(parsed.data.results)
    ? (parsed.data.results as ValidationCheck[])
    : [];
  const missing = Array.isArray(parsed.data.missing)
    ? (parsed.data.missing as ValidationMissing[])
    : [];
  const passedChecks = results.filter((result) => result.status === "passed").length;
  const failedChecks = results.filter((result) => result.status === "failed").length;
  const errorChecks = results.filter((result) => result.status === "error").length;
  const blockedChecks = Math.max(0, checks.length - results.length);
  const missingRequiredCapabilities = missing.filter((item) => item.optional === false).length;
  const subjects = checks.length + missingRequiredCapabilities;
  const score = subjects > 0 ? Math.round((passedChecks / subjects) * 100) : null;

  return {
    source: "coding-tooling/run/v1",
    reportPath,
    status,
    score,
    plannedChecks: checks.length,
    passedChecks,
    failedChecks,
    errorChecks,
    blockedChecks,
    missingRequiredCapabilities,
  };
}

function normalizeStructuralCompleteness(score: StructuralScoreDocument): StructuralScoreDocument {
  const unmodeledDetectors = score.audits.filter(
    (audit) => audit.coverageStatus === "applied" && audit.scoreModel === "unavailable",
  ).length;
  const modeledDetectors = score.audits.filter((audit) => audit.scoreModel === "subject-v1").length;
  const completeness: RepositoryScoreCompleteness =
    score.score === null
      ? "unavailable"
      : score.coverage.incompleteDetectors > 0 ||
          unmodeledDetectors > 0 ||
          score.coverage.unsupportedTechnologies.length > 0
        ? "incomplete"
        : "complete";
  return {
    ...score,
    completeness,
    coverage: {
      ...score.coverage,
      modeledDetectors,
      unmodeledDetectors,
    },
  };
}

export function combineRepositoryScore(
  structuralInput: StructuralScoreDocument,
  verification: RepositoryVerificationScore | null,
): RepositoryProgressScoreDocument {
  const structural = normalizeStructuralCompleteness(structuralInput);
  const overall =
    structural.score === null
      ? null
      : verification?.score === null || verification === null
        ? structural.score
        : Math.round((structural.score + verification.score) / 2);
  const completeness: RepositoryScoreCompleteness =
    overall === null
      ? "unavailable"
      : structural.completeness !== "complete" || verification?.score === null || !verification
        ? "incomplete"
        : "complete";
  const categories: RepositoryProgressCategoryScore[] = [...structural.categories];
  if (verification?.score !== null && verification) {
    categories.push({ id: "verification", score: verification.score, auditCount: 1 });
    categories.sort((left, right) => left.id.localeCompare(right.id));
  }

  return {
    schemaVersion: "coding-tooling/repository-score/v1",
    score: overall,
    rating: rating(overall),
    completeness,
    structuralScore: structural.score,
    verificationScore: verification?.score ?? null,
    categories,
    audits: structural.audits,
    verification,
    coverage: structural.coverage,
    findings: structural.findings,
    notes: [
      "The overall score combines structural expectation evidence with fresh repository verification when a run report is supplied.",
      "Structural and verification scores receive equal weight in v1 so a red verification pipeline cannot be hidden by structurally complete metadata.",
      "Without a validation report the numeric score remains a structural estimate and completeness is incomplete.",
      ...structural.notes,
    ],
  };
}

export function repositoryProgressScoreCommand(
  root: string,
  options: { validationReportPath?: string } = {},
): RepositoryProgressScoreEnvelope {
  const started = Date.now();
  const structuralEnvelope = structuralRepositoryScoreCommand(root);
  const structural = structuralEnvelope.data.score;
  if (!structural) {
    return {
      schemaVersion: 1,
      operation: "score",
      status: structuralEnvelope.status,
      durationMs: Date.now() - started,
      data: { root },
      diagnostics: structuralEnvelope.diagnostics,
    };
  }

  try {
    const verification = options.validationReportPath
      ? validationScore(root, options.validationReportPath)
      : null;
    const score = combineRepositoryScore(structural, verification);
    return {
      schemaVersion: 1,
      operation: "score",
      status: score.score === null ? "unavailable" : "passed",
      durationMs: Date.now() - started,
      data: { root, score },
      diagnostics: structuralEnvelope.diagnostics,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "score",
      status: "error",
      durationMs: Date.now() - started,
      data: { root },
      diagnostics: [
        ...structuralEnvelope.diagnostics,
        {
          code: "repository-verification-score-failed",
          message: error instanceof Error ? error.message : String(error),
          path: options.validationReportPath,
        },
      ],
    };
  }
}
