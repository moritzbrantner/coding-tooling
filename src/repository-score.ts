import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./core.ts";
import { productionSourceFiles } from "./expectation-gap-detectors.ts";
import { createDetectorContext, type PackageInfo } from "./expectation-package-context.ts";
import { explicitCargoTargets } from "./expectation-rust-detector.ts";
import { rustTestSurfaces } from "./expectation-rust-test-detector.ts";
import {
  analyzeExpectations,
  expectationRegistry,
  type ExpectationRegistryEntry,
  type Finding,
  type FindingsCoverage,
} from "./expectations.ts";
import type { ResultStatus } from "./model.ts";
import { relativePosix } from "./shared.ts";

export type RepositoryScoreCategory =
  | "correctness"
  | "testing"
  | "automation"
  | "maintainability"
  | "performance"
  | "other";

export type RepositoryScoreRating =
  | "good"
  | "needs-improvement"
  | "poor"
  | "unavailable";
export type RepositoryScoreCompleteness = "complete" | "incomplete" | "unavailable";

export type RepositoryAuditScore = {
  id: string;
  version: number;
  description: string;
  category: RepositoryScoreCategory;
  severity: ExpectationRegistryEntry["defaultSeverity"];
  coverageStatus: FindingsCoverage["detectors"][number]["status"];
  coverageSubjects: number;
  scoreModel: "subject-v1" | "unavailable";
  subjects: number | null;
  failedSubjects: number | null;
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
    modeledDetectors: number;
    unmodeledDetectors: number;
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

type ScoreFinding = Pick<
  Finding,
  "expectationId" | "disposition" | "subject" | "requirement" | "analysisEvidence"
>;

type ScoreSubjects = {
  subjects: number;
  failedSubjects: number;
};

type ScoreSubjectMap = ReadonlyMap<string, ScoreSubjects>;

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
  ) {
    return "correctness";
  }
  if (id.includes("aggregate-check") || id.includes("required-capability")) return "automation";
  if (id.includes("config") || id.includes("debt")) return "maintainability";
  return "other";
}

function weightedAverage(values: Array<{ score: number; weight: number }>): number | null {
  const weight = values.reduce((sum, value) => sum + value.weight, 0);
  if (weight === 0) return null;
  return Math.round(
    values.reduce((sum, value) => sum + value.score * value.weight, 0) / weight,
  );
}

function rating(score: number | null): RepositoryScoreRating {
  if (score === null) return "unavailable";
  if (score >= 90) return "good";
  if (score >= 50) return "needs-improvement";
  return "poor";
}

function unresolved(findings: readonly ScoreFinding[], expectationId: string): ScoreFinding[] {
  return findings.filter(
    (finding) => finding.expectationId === expectationId && finding.disposition !== "verified",
  );
}

function countSubjects(subjects: Iterable<string>, failedSubjects: Iterable<string>): ScoreSubjects {
  const subjectSet = new Set(subjects);
  const failedSet = new Set(
    [...failedSubjects].filter((subject) => subjectSet.has(subject)),
  );
  return { subjects: subjectSet.size, failedSubjects: failedSet.size };
}

function packageHasBenchmark(packageInfo: PackageInfo): boolean {
  const scripts = packageInfo.manifest.scripts ?? {};
  return ["benchmark", "benchmark:smoke", "bench"].some((name) => {
    const command = scripts[name];
    return typeof command === "string" && command.trim().length > 0;
  });
}

function packageNeedsAggregateCheck(packageInfo: PackageInfo): boolean {
  const scripts = packageInfo.manifest.scripts ?? {};
  const candidates = ["format:check", "lint", "typecheck", "test", "test:unit", "build"];
  return candidates.filter((name) => typeof scripts[name] === "string").length >= 2;
}

function packageHasCliSurface(packageInfo: PackageInfo): boolean {
  const bin = packageInfo.manifest.bin;
  const hasBin =
    typeof bin === "string" ||
    (bin !== undefined && Object.values(bin).some((value) => typeof value === "string"));
  return hasBin || existsSync(join(packageInfo.directory, "src", "cli.ts"));
}

function packageForFindingPath(packages: readonly PackageInfo[], path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const nested = packages
    .filter(
      (packageInfo) =>
        packageInfo.path !== "." &&
        (normalized === packageInfo.path || normalized.startsWith(`${packageInfo.path}/`)),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (nested) return nested.path;
  return packages.some((packageInfo) => packageInfo.path === ".") ? "." : undefined;
}

function directFindingSubjects(
  findings: readonly ScoreFinding[],
  expectationId: string,
): string[] {
  return unresolved(findings, expectationId).map((finding) => finding.subject.key);
}

function repositoryScoreSubjects(root: string, findings: readonly ScoreFinding[]): ScoreSubjectMap {
  const context = createDetectorContext(root);
  const models = new Map<string, ScoreSubjects>();

  const javascriptSources = context.packages.flatMap((packageInfo) =>
    packageInfo.javaScriptSourceFiles.map((path) => relativePosix(root, path)),
  );
  const typeScriptSources = context.packages.flatMap((packageInfo) =>
    packageInfo.sourceFiles.map((path) => relativePosix(root, path)),
  );
  const productionSources = productionSourceFiles(root).map((path) => relativePosix(root, path));

  models.set(
    "javascript-source-test",
    countSubjects(
      javascriptSources,
      directFindingSubjects(findings, "javascript-source-test"),
    ),
  );
  models.set(
    "typescript-source-test",
    countSubjects(typeScriptSources, directFindingSubjects(findings, "typescript-source-test")),
  );
  models.set(
    "source-debt-marker",
    countSubjects(productionSources, directFindingSubjects(findings, "source-debt-marker")),
  );
  models.set(
    "source-unimplemented-stub",
    countSubjects(
      productionSources,
      directFindingSubjects(findings, "source-unimplemented-stub"),
    ),
  );

  const testCapabilityPackages = context.packages
    .filter(
      (packageInfo) =>
        packageInfo.sourceFiles.length + packageInfo.javaScriptSourceFiles.length > 0,
    )
    .map((packageInfo) => packageInfo.path);
  models.set(
    "package-test-capability",
    countSubjects(
      testCapabilityPackages,
      directFindingSubjects(findings, "package-test-capability"),
    ),
  );

  const typeScriptPackages = context.packages
    .filter((packageInfo) => packageInfo.sourceFiles.length > 0)
    .map((packageInfo) => packageInfo.path);
  models.set(
    "typescript-project-config",
    countSubjects(
      typeScriptPackages,
      directFindingSubjects(findings, "typescript-project-config"),
    ),
  );

  const aggregatePackages = context.packages
    .filter(packageNeedsAggregateCheck)
    .map((packageInfo) => packageInfo.path);
  models.set(
    "package-aggregate-check",
    countSubjects(
      aggregatePackages,
      directFindingSubjects(findings, "package-aggregate-check"),
    ),
  );

  const benchmarkPackages = context.packages
    .filter(packageHasBenchmark)
    .map((packageInfo) => packageInfo.path);
  models.set(
    "benchmark-evidence",
    countSubjects(
      benchmarkPackages,
      directFindingSubjects(findings, "benchmark-evidence"),
    ),
  );

  const cliPackages = context.packages.filter(packageHasCliSurface).map((packageInfo) => packageInfo.path);
  const cliFailures = unresolved(findings, "package-cli-wiring")
    .map((finding) =>
      finding.subject.kind === "package"
        ? finding.subject.key
        : packageForFindingPath(context.packages, finding.subject.path),
    )
    .filter((value): value is string => value !== undefined);
  models.set("package-cli-wiring", countSubjects(cliPackages, cliFailures));

  const requiredCapabilities = loadConfig(root).requiredCapabilities ?? [];
  const missingCapabilities = unresolved(findings, "required-capability-available").map(
    (finding) => finding.requirement.key,
  );
  models.set(
    "required-capability-available",
    countSubjects(requiredCapabilities, missingCapabilities),
  );

  const cargoTargets = explicitCargoTargets(root).map(
    (target) =>
      `${target.manifestPath}#${target.kind}:${target.name ?? target.declaredPath}`,
  );
  models.set(
    "rust-cargo-target-path",
    countSubjects(cargoTargets, directFindingSubjects(findings, "rust-cargo-target-path")),
  );

  models.set(
    "rust-source-test",
    countSubjects(
      rustTestSurfaces(root),
      directFindingSubjects(findings, "rust-source-test"),
    ),
  );

  const typeScriptProvider = context.analysisProvider("typescript-compiler");
  const typeScriptProjects = typeScriptProvider?.projects ?? [];
  const failedTypeScriptProjects = unresolved(findings, "typescript-type-assignability").flatMap(
    (finding) =>
      finding.analysisEvidence
        ?.map((evidence) => evidence.project)
        .filter((project): project is string => project !== undefined) ?? [],
  );
  models.set(
    "typescript-type-assignability",
    countSubjects(typeScriptProjects, failedTypeScriptProjects),
  );

  return models;
}

export function scoreExpectationEvidence(
  findings: readonly ScoreFinding[],
  coverage: FindingsCoverage,
  registry: readonly ExpectationRegistryEntry[],
  scoreSubjects: ScoreSubjectMap,
): RepositoryScoreDocument {
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  const audits = coverage.detectors
    .map((detector): RepositoryAuditScore => {
      const descriptor = registryById.get(detector.id);
      const matching = findings.filter((finding) => finding.expectationId === detector.id);
      const subjectModel = scoreSubjects.get(detector.id);
      const applied = subjectModel !== undefined && subjectModel.subjects > 0;
      const auditScore = applied
        ? Math.round(
            ((subjectModel.subjects - subjectModel.failedSubjects) / subjectModel.subjects) * 100,
          )
        : null;
      return {
        id: detector.id,
        version: detector.version,
        description: descriptor?.description ?? detector.id,
        category: categoryForExpectation(detector.id),
        severity: descriptor?.defaultSeverity ?? "warning",
        coverageStatus: detector.status,
        coverageSubjects: detector.subjects,
        scoreModel: subjectModel === undefined ? "unavailable" : "subject-v1",
        subjects: subjectModel?.subjects ?? null,
        failedSubjects: subjectModel?.failedSubjects ?? null,
        activeFindings: matching.filter((finding) => finding.disposition === "active").length,
        suppressedFindings: matching.filter((finding) => finding.disposition === "suppressed").length,
        verifiedFindings: matching.filter((finding) => finding.disposition === "verified").length,
        score: auditScore,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const scoredAudits = audits.filter(
    (audit): audit is RepositoryAuditScore & { score: number } => audit.score !== null,
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
  const unmodeledDetectors = audits.filter((audit) => audit.scoreModel === "unavailable").length;
  const completeness: RepositoryScoreCompleteness =
    overall === null
      ? "unavailable"
      : incompleteDetectors > 0 ||
          unmodeledDetectors > 0 ||
          coverage.unsupportedTechnologies.length > 0
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
      modeledDetectors: audits.length - unmodeledDetectors,
      unmodeledDetectors,
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
      "Detector scan coverage and score subjects are separate: scoring uses detector-specific requirement units such as files, packages, configured capabilities, Cargo targets, or TypeScript projects.",
      "Only modeled audits with applicable score subjects contribute; unavailable coverage or a missing score model marks the result incomplete instead of counting as zero.",
      "Baselining does not improve the score, and suppressed findings remain score-relevant; explicit verification evidence can satisfy a finding.",
      "Audit scores are the percentage of applicable score subjects without unresolved findings; the overall score is a severity-weighted average of applicable audits.",
    ],
  };
}

export function repositoryScoreCommand(root: string): RepositoryScoreEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root, { includeSuppressed: true });
    const subjects = repositoryScoreSubjects(root, analysis.findings);
    const score = scoreExpectationEvidence(
      analysis.findings,
      analysis.coverage,
      expectationRegistry(),
      subjects,
    );
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
