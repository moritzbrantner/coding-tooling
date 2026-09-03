import { describe, expect, test } from "bun:test";

import type {
  ExpectationRegistryEntry,
  Finding,
  FindingsCoverage,
} from "../src/expectations.ts";
import { scoreExpectationEvidence } from "../src/repository-score.ts";

function registry(id: string, severity: ExpectationRegistryEntry["defaultSeverity"] = "warning") {
  return {
    id,
    version: 1,
    description: id,
    defaultSeverity: severity,
    policyKind: "advisory" as const,
  };
}

function finding(
  expectationId: string,
  subject: string,
  disposition: Finding["disposition"] = "active",
) {
  return {
    expectationId,
    disposition,
    subject: {
      kind: "file" as const,
      key: subject,
      path: subject,
      description: subject,
    },
  };
}

function coverage(detectors: FindingsCoverage["detectors"]): FindingsCoverage {
  return {
    schemaVersion: 1,
    technologies: ["typescript"],
    detectors,
    unsupportedTechnologies: [],
  };
}

describe("repository score", () => {
  test("scores the share of covered subjects without unresolved findings", () => {
    const score = scoreExpectationEvidence(
      [finding("typescript-source-test", "src/a.ts")],
      coverage([
        {
          id: "typescript-source-test",
          version: 1,
          status: "applied",
          subjects: 2,
        },
      ]),
      [registry("typescript-source-test")],
    );

    expect(score.score).toBe(50);
    expect(score.rating).toBe("needs-improvement");
    expect(score.completeness).toBe("complete");
    expect(score.categories).toEqual([{ id: "testing", score: 50, auditCount: 1 }]);
  });

  test("does not reward suppression or baselining while verified evidence can satisfy a finding", () => {
    const score = scoreExpectationEvidence(
      [
        finding("typescript-source-test", "src/active.ts", "active"),
        finding("typescript-source-test", "src/suppressed.ts", "suppressed"),
        finding("typescript-source-test", "src/verified.ts", "verified"),
      ],
      coverage([
        {
          id: "typescript-source-test",
          version: 1,
          status: "applied",
          subjects: 3,
        },
      ]),
      [registry("typescript-source-test")],
    );

    expect(score.score).toBe(33);
    expect(score.findings).toEqual({ active: 1, suppressed: 1, verified: 1 });
    expect(score.audits[0]).toMatchObject({
      failedSubjects: 2,
      activeFindings: 1,
      suppressedFindings: 1,
      verifiedFindings: 1,
    });
  });

  test("excludes unavailable coverage from the denominator and marks the score incomplete", () => {
    const score = scoreExpectationEvidence(
      [],
      coverage([
        {
          id: "typescript-source-test",
          version: 1,
          status: "applied",
          subjects: 2,
        },
        {
          id: "typescript-type-assignability",
          version: 1,
          status: "unavailable",
          subjects: 0,
        },
      ]),
      [registry("typescript-source-test"), registry("typescript-type-assignability")],
    );

    expect(score.score).toBe(100);
    expect(score.completeness).toBe("incomplete");
    expect(score.coverage.incompleteDetectors).toBe(1);
    expect(score.audits.find((audit) => audit.id === "typescript-type-assignability")?.score).toBeNull();
  });
});
