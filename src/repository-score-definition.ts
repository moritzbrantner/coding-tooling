import { createHash } from "node:crypto";

import type { RepositoryAuditScore } from "./repository-score.ts";

export const REPOSITORY_SCORE_DEFINITION_SCHEMA_V1 =
  "coding-tooling/repository-score-definition/v1" as const;

const severityWeights = {
  info: 1,
  warning: 2,
  error: 3,
} as const;

export type RepositoryScoreDefinitionAudit = {
  id: string;
  version: number;
  category: RepositoryAuditScore["category"];
  severity: RepositoryAuditScore["severity"];
  weight: number;
  scoreModel: RepositoryAuditScore["scoreModel"];
};

export type RepositoryScoreDefinition = {
  schemaVersion: typeof REPOSITORY_SCORE_DEFINITION_SCHEMA_V1;
  profileVersion: string;
  fingerprint: string;
  structural: {
    auditFormula: "satisfied-subject-ratio-v1";
    aggregation: "severity-weighted-audit-average-v1";
    severityWeights: typeof severityWeights;
    audits: RepositoryScoreDefinitionAudit[];
  };
  verification: {
    formula: "passed-obligation-ratio-v1";
    plannedCheckWeight: 1;
    missingRequiredCapabilityWeight: 1;
    failedErroredBlockedChecksEarnCredit: false;
  };
  overall: {
    aggregation: "equal-structural-verification-average-v1";
    structuralWeight: 1;
    verificationWeight: 1;
    structuralOnlyFallback: "structural-estimate-incomplete";
  };
  ratings: {
    goodAtLeast: 90;
    needsImprovementAtLeast: 50;
  };
};

type DefinitionWithoutFingerprint = Omit<RepositoryScoreDefinition, "fingerprint">;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

export function repositoryScoreDefinition(
  audits: readonly RepositoryAuditScore[],
  profileVersion: string,
): RepositoryScoreDefinition {
  const definition: DefinitionWithoutFingerprint = {
    schemaVersion: REPOSITORY_SCORE_DEFINITION_SCHEMA_V1,
    profileVersion,
    structural: {
      auditFormula: "satisfied-subject-ratio-v1",
      aggregation: "severity-weighted-audit-average-v1",
      severityWeights,
      audits: audits
        .map((audit) => ({
          id: audit.id,
          version: audit.version,
          category: audit.category,
          severity: audit.severity,
          weight: severityWeights[audit.severity],
          scoreModel: audit.scoreModel,
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    },
    verification: {
      formula: "passed-obligation-ratio-v1",
      plannedCheckWeight: 1,
      missingRequiredCapabilityWeight: 1,
      failedErroredBlockedChecksEarnCredit: false,
    },
    overall: {
      aggregation: "equal-structural-verification-average-v1",
      structuralWeight: 1,
      verificationWeight: 1,
      structuralOnlyFallback: "structural-estimate-incomplete",
    },
    ratings: {
      goodAtLeast: 90,
      needsImprovementAtLeast: 50,
    },
  };

  return {
    ...definition,
    fingerprint: digest(definition),
  };
}
