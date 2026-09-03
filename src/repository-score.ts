import {
  analyzeExpectations,
  expectationRegistry,
  type ExpectationRegistryEntry,
  type Finding,
  type FindingsCoverage,
} from "./expectations.ts";
import type { ResultStatus } from "./model.ts";

export type RepositoryScoreCategory =
  | "correctness"
  | "testing"
  | "automation"
  | "maintainability"
  | "performance"
  | "other";

export type RepositoryScoreRating = "good" | "needs-improvement" | "poor" | "unavailable";
export type RepositoryScoreCompleteness = "complete" | "incomplete" | "unavailable";

export type RepositoryAuditScore = {
  id: string;
  version: number;
  description: string;
  category: RepositoryScoreCategory;
  severity: ExpectationRegistryEntry["defaultSeverity"];
  coverageStatus: FindingsCoverage["detectors"][number]["status"];
  subjects: number;
  failedSubjects: number;
  activeFindings: number;
  suppressedFindings: number;
  verifiedFindings: number;
  score: number | null;
};

export type RepositoryCategoryScore = {
  id: RepositoryScoreCategory;
  score: number;
  auditCount: number;
};

export type RepositoryScoreDocument = {
  schemaVersion: "coding-tooling/repository-score/v1";
  score: number | null;
  rating: RepositoryScoreRating;
  completeness: RepositoryScoreCompleteness;
  categories: RepositoryCategoryScore[];
  audits: RepositoryAuditScore[];
  coverage: {
    appliedDetectors: number;
    incompleteDetectors: number;
    notApplicableDetectors: number;
    unsupportedTechnologies: string[];
  };
  findings: {
    active: number;
    suppressed: number;
    verified: number;
  };
  notes: string[];
};

export type RepositoryScoreEnvelope = {
  schemaVersion: 1;
  operation: "score";
  status: ResultStatus;
  durationMs: number;
  data: {
    root: string;
    score?: RepositoryScoreDocument;
  };
  diagnostics: Array<{ code?: string; message: string; path?: string }>;
};

type ScoreFinding = Pick<Finding, "expectationId" | "disposition" | "subject">;

const severityWeight: Record<ExpectationRegistryEntry["defaultSeverity"], number> = {
  info: 1,
  warning: 2,
  error: 3,
};

function categoryForExpectation(id: string): RepositoryScoreCategory {
  if (id.includes("benchmark")) return "performance";
  if (id.includes("test")) return "testing";
  if (
    id.includes("assignability") ||
    id.includes("cargo-target") ||
    id.includes("cli-wiring") ||
    id.includes("unimplemented")
  )
    return "correctness";
  if (id.includes("aggregate-check") || id.includes("required-capability")) return "automation";
  if (id.includes("config") || id.includes("debt")) return "maintainability";
  return "other";
}

function weightedAverage(values: Array<{ score: number; weight: number }>): number | null {
  const weight = values.reduce((sum, value) => sum + value.weight, 0);
  if (weight === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value.score * value.weight, 0) / weight);
}

function rating(score: number | null): RepositoryScoreRating {
  if (score === null) return "unavailable";
  if (score >= 90) return "good";
  if (score >= 50) return "needs-improvement";
  return "poor";
}

export function scoreExpectationEvidence(
  findings: readonly ScoreFinding[],
  coverage: FindingsCoverage,
  registry: readonly ExpectationRegistryEntry[],
): RepositoryScoreDocument {
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  const audits = coverage.detectors
    .map((detector): RepositoryAuditScore => {
      const descriptor = registryById.get(detector.id);
      const matching = findings.filter((finding) => finding.expectationId === detector.id);
      const failed = matching.filter((finding) => finding.disposition !== "verified");
      const failedSubjects = new Set(failed.map((finding) => finding.subject.key));
      const applied = detector.status === "applied" && detector.subjects > 0;
      const failedSubjectCount = applied ? Math.min(detector.subjects, failedSubjects.size) : 0;
      const auditScore = applied
        ? Math.round(((detector.subjects - failedSubjectCount) / detector.subjects) * 100)
        : null;
      return {
        id: detector.id,
        version: detector.version,
        description: descriptor?.description ?? detector.id,
        category: categoryForExpectation(detector.id),
        severity: descriptor?.defaultSeverity ?? "warning",
        coverageStatus: detector.status,
        subjects: detector.subjects,
        failedSubjects: failedSubjectCount,
        activeFindings: matching.filter((finding) => finding.disposition === "active").length,
        suppressedFindings: matching.filter((finding) => finding.disposition === "suppressed").length,
        verifiedFindings: matching.filter((finding) => finding.disposition === "verified").length,
        score: auditScore,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const scoredAudits = audits.filter((audit): audit is RepositoryAuditScore & { score: number } =>
    audit.score !== null,
  );
  const overall = weightedAverage(
    scoredAudits.map((audit) => ({ score: audit.score, weight: severityWeight[audit.severity] })),
  );

  const categories = [...new Set(scoredAudits.map((audit) => audit.category))]
    .sort()
    .map((category): RepositoryCategoryScore => {
      const categoryAudits = scoredAudits.filter((audit) => audit.category === category);
      return {
        id: category,
        score:
          weightedAverage(
            categoryAudits.map((audit) => ({
              score: audit.score,
              weight: severityWeight[audit.severity],
            })),
          ) ?? 0,
        auditCount: categoryAudits.length,
      };
    });

  const incompleteDetectors = coverage.detectors.filter(
    (detector) => detector.status === "unsupported" || detector.status === "unavailable",
  ).length;
  const completeness: RepositoryScoreCompleteness =
    overall === null
      ? "unavailable"
      : incompleteDetectors > 0 || coverage.unsupportedTechnologies.length > 0
        ? "incomplete"
        : "complete";

  return {
    schemaVersion: "coding-tooling/repository-score/v1",
    score: overall,
    rating: rating(overall),
    completeness,
    categories,
    audits,
    coverage: {
      appliedDetectors: coverage.detectors.filter((detector) => detector.status === "applied").length,
      incompleteDetectors,
      notApplicableDetectors: coverage.detectors.filter(
        (detector) => detector.status === "not-applicable",
      ).length,
      unsupportedTechnologies: coverage.unsupportedTechnologies,
    },
    findings: {
      active: findings.filter((finding) => finding.disposition === "active").length,
      suppressed: findings.filter((finding) => finding.disposition === "suppressed").length,
      verified: findings.filter((finding) => finding.disposition === "verified").length,
    },
    notes: [
      "Scores are versioned structural evidence summaries, not claims of semantic correctness or repository value.",
      "Only applied detectors contribute to the score; unavailable and unsupported coverage marks the result incomplete instead of counting as zero.",
      "Baselining does not improve the score, and suppressed findings remain score-relevant; explicit verification evidence can satisfy a finding.",
      "Audit scores are the percentage of covered subjects without unresolved findings; the overall score is a severity-weighted average of applicable audits.",
    ],
  };
}

export function repositoryScoreCommand(root: string): RepositoryScoreEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root, { includeSuppressed: true });
    const score = scoreExpectationEvidence(analysis.findings, analysis.coverage, expectationRegistry());
    return {
      schemaVersion: 1,
      operation: "score",
      status: score.score === null ? "unavailable" : "passed",
      durationMs: Date.now() - started,
      data: { root, score },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "score",
      status: "error",
      durationMs: Date.now() - started,
      data: { root },
      diagnostics: [
        {
          code: "repository-score-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
