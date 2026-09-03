import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  combineRepositoryScore,
  REPOSITORY_SCORE_PROFILE_VERSION,
  repositoryProgressScoreCommand,
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

    expect(score.profileVersion).toBe(REPOSITORY_SCORE_PROFILE_VERSION);
    expect(score.score).toBe(88);
    expect(score.rating).toBe("needs-improvement");
    expect(score.completeness).toBe("complete");
    expect(score.structuralScore).toBe(100);
    expect(score.verificationScore).toBe(75);
    expect(score.categories).toContainEqual({ id: "verification", score: 75, auditCount: 1 });
    expect(score.definition.schemaVersion).toBe("coding-tooling/repository-score-definition/v1");
    expect(score.definition.profileVersion).toBe(REPOSITORY_SCORE_PROFILE_VERSION);
    expect(score.definition.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("fingerprints the effective scoring definition independently of audit ordering", () => {
    const left = combineRepositoryScore(
      structural([audit("z-detector"), audit("a-detector")]),
      verification(100),
    );
    const right = combineRepositoryScore(
      structural([audit("a-detector"), audit("z-detector")]),
      verification(100),
    );
    const changed = combineRepositoryScore(
      structural([audit("a-detector", { version: 2 }), audit("z-detector")]),
      verification(100),
    );

    expect(left.definition.fingerprint).toBe(right.definition.fingerprint);
    expect(changed.definition.fingerprint).not.toBe(left.definition.fingerprint);
    expect(left.definition.structural.audits.map((item) => item.id)).toEqual([
      "a-detector",
      "z-detector",
    ]);
  });

  test("keeps a structural-only estimate explicitly incomplete", () => {
    const score = combineRepositoryScore(structural(), null);

    expect(score.score).toBe(100);
    expect(score.rating).toBe("good");
    expect(score.completeness).toBe("incomplete");
    expect(score.verificationScore).toBeNull();
    expect(score.verification).toBeNull();
  });

  test("keeps score profile identity when verification evidence cannot be read", () => {
    const root = resolve(import.meta.dir, "..");
    const result = repositoryProgressScoreCommand(root, {
      validationReportPath: ".artifacts/coding-tooling/definitely-missing-history-run.json",
    });

    expect(result.status).toBe("error");
    expect(result.profileVersion).toBe(REPOSITORY_SCORE_PROFILE_VERSION);
    expect(result.data.score).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-verification-score-failed" }),
    );
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
