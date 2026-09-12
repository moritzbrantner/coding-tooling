import type { ResultStatus } from "./model.ts";
import type {
  PreparedTestCaseEvidenceRun,
  TestCaseEvidenceReadResult,
  TestCaseOutcome,
} from "./test-case-evidence.ts";

export const publicContractHttpBehaviors = [
  "availability",
  "validation",
  "authorization",
  "success",
  "persistence",
  "not-found",
  "idempotency",
  "cancellation",
  "concurrency",
] as const;

export type PublicContractHttpBehavior = (typeof publicContractHttpBehaviors)[number];

export type PublicContractCaseReference = {
  id: string;
  behavior: PublicContractHttpBehavior;
};

export type PublicContractCaseEvidence = {
  id?: string;
  behavior?: PublicContractHttpBehavior;
  path?: string;
  outcome: TestCaseOutcome | "missing" | "invalid";
  reason?: string;
};

export type PublicContractCaseExecution = {
  capabilityOutcome: ResultStatus;
  prepared?: PreparedTestCaseEvidenceRun;
  evidence?: TestCaseEvidenceReadResult;
};

export function validatePublicContractCaseReference(reference: PublicContractCaseReference): void {
  if (!reference.id?.trim()) throw new Error("Public contract case id must not be empty");
  if (!publicContractHttpBehaviors.includes(reference.behavior)) {
    throw new Error(`Unknown public contract HTTP behavior: ${String(reference.behavior)}`);
  }
}

export function resolvePublicContractCaseEvidence(
  reference: PublicContractCaseReference | undefined,
  execution: PublicContractCaseExecution,
): { outcome: ResultStatus; caseEvidence: PublicContractCaseEvidence } {
  if (!reference) {
    return {
      outcome: "unavailable",
      caseEvidence: {
        outcome: "missing",
        reason: "http-case-declaration-missing",
      },
    };
  }

  const base: PublicContractCaseEvidence = {
    id: reference.id,
    behavior: reference.behavior,
    path: execution.prepared?.path,
    outcome: "missing",
  };
  if (execution.capabilityOutcome !== "passed") {
    return {
      outcome: execution.capabilityOutcome,
      caseEvidence: {
        ...base,
        reason: "capability-did-not-pass",
      },
    };
  }
  if (!execution.evidence) {
    return {
      outcome: "unavailable",
      caseEvidence: {
        ...base,
        reason: "test-case-evidence-not-requested",
      },
    };
  }
  if (execution.evidence.status === "missing") {
    return {
      outcome: "unavailable",
      caseEvidence: {
        ...base,
        reason: execution.evidence.reason,
      },
    };
  }
  if (execution.evidence.status === "invalid") {
    return {
      outcome: "error",
      caseEvidence: {
        ...base,
        outcome: "invalid",
        reason: execution.evidence.reason,
      },
    };
  }

  const caseOutcome = execution.evidence.cases.get(reference.id);
  if (!caseOutcome) {
    return {
      outcome: "unavailable",
      caseEvidence: {
        ...base,
        reason: "test-case-evidence-case-missing",
      },
    };
  }
  if (caseOutcome === "passed") {
    return {
      outcome: "passed",
      caseEvidence: { ...base, outcome: caseOutcome },
    };
  }
  if (caseOutcome === "failed") {
    return {
      outcome: "failed",
      caseEvidence: { ...base, outcome: caseOutcome },
    };
  }
  return {
    outcome: "unavailable",
    caseEvidence: {
      ...base,
      outcome: caseOutcome,
      reason: `test-case-evidence-${caseOutcome}`,
    },
  };
}
