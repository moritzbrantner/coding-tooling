import { describe, expect, test } from "bun:test";

import {
  combineRepositoryScore,
  type RepositoryVerificationScore,
} from "../src/repository-progress-score.ts";
import type { RepositoryAuditScore, RepositoryScoreDocument } from "../src/repository-score.ts";

function audit(id: string, options: Partial<RepositoryAuditScore> = {}): RepositoryAuditScore {
  return {
    id,
    version: 1,
    description: id,
    category: "testing",
    severity: "warning",
    coverageStatus: "applied",
    coverageSubjects: 1,
    scoreModel: "subject-v1",
    subjects: 1,
    failedSubjects: 0,
    activeFindings: 0,
    suppressedFindings: 0,
    verifiedFindings: 0,
    score: 100,
    ...options,
  };
}

function structural(audits: RepositoryAuditScore[] = [audit("typescript-source-test")]) {
  const score: RepositoryScoreDocument = {
    schemaVersion: "coding-tooling/repository-score/v1",
    score: 100,
    rating: "good",
    completeness: "complete",
    categories: [{ id: "testing", score: 100, auditCount: 1 }],
    audits,
    coverage: {
      appliedDetectors: audits.filter((item) => item.coverageStatus === "applied").length,
      modeledDetectors: audits.filter((item) => item.scoreModel === "subject-v1").length,
      unmodeledDetectors: audits.filter((item) => item.scoreModel === "unavailable").length,
      incompleteDetectors: 0,
      notApplicableDetectors: audits.filter((item) => item.coverageStatus === "not-applicable")
        .length,
      unsupportedTechnologies: [],
    },
    findings: { active: 0, suppressed: 0, verified: 0 },
    notes: ["structural note"],
  };
  return score;
}

function verification(score = 75): RepositoryVerificationScore {
  return {
    source: "coding-tooling/run/v1",
    reportPath: ".artifacts/coding-tooling/run.json",
    status: "failed",
    score,
    plannedChecks: 4,
    passedChecks: 3,
    failedChecks: 1,
    errorChecks: 0,
    blockedChecks: 0,
    missingRequiredCapabilities: 0,
  };
}

describe("repository progress score", () => {
  test("combines structural evidence with fresh verification equally", () => {
    const score = combineRepositoryScore(structural(), verification());

    expect(score.score).toBe(88);
    expect(score.rating).toBe("needs-improvement");
    expect(score.completeness).toBe("complete");
    expect(score.structuralScore).toBe(100);
    expect(score.verificationScore).toBe(75);
    expect(score.categories).toContainEqual({ id: "verification", score: 75, auditCount: 1 });
  });

  test("keeps a structural-only estimate explicitly incomplete", () => {
    const score = combineRepositoryScore(structural(), null);

    expect(score.score).toBe(100);
    expect(score.rating).toBe("good");
    expect(score.completeness).toBe("incomplete");
    expect(score.verificationScore).toBeNull();
    expect(score.verification).toBeNull();
  });

  test("does not treat a not-applicable detector without a score model as incomplete", () => {
    const score = combineRepositoryScore(
      structural([
        audit("typescript-source-test"),
        audit("dotnet-type-assignability", {
          coverageStatus: "not-applicable",
          coverageSubjects: 0,
          scoreModel: "unavailable",
          subjects: null,
          failedSubjects: null,
          score: null,
        }),
      ]),
      verification(100),
    );

    expect(score.completeness).toBe("complete");
    expect(score.coverage.unmodeledDetectors).toBe(0);
  });

  test("keeps an applied detector without a score model incomplete", () => {
    const score = combineRepositoryScore(
      structural([
        audit("typescript-source-test"),
        audit("future-detector", {
          scoreModel: "unavailable",
          subjects: null,
          failedSubjects: null,
          score: null,
        }),
      ]),
      verification(100),
    );

    expect(score.completeness).toBe("incomplete");
    expect(score.coverage.unmodeledDetectors).toBe(1);
  });
});
