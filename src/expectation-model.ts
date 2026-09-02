import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ResultStatus } from "./model.ts";
import { readJson } from "./shared.ts";

export type FindingSeverity = "info" | "warning" | "error";
export type FindingState = "new" | "baseline";
export type FindingDisposition = "active" | "suppressed";
export type FindingRelationshipKind =
  | "requires"
  | "blocks"
  | "related-to"
  | "same-subject"
  | "same-expectation";

export type FindingSubject = {
  kind: "repository" | "package" | "file";
  key: string;
  path?: string;
  description: string;
};

export type FindingRequirement = {
  kind: "test" | "check" | "file" | "wiring" | "signal";
  key: string;
  description: string;
  expectedArtifact?: string;
};

export type FindingEvidence = {
  kind: "file" | "manifest" | "config";
  path: string;
  detail: string;
};

export type FindingRelationship = {
  kind: FindingRelationshipKind;
  targetId: string;
};

export type FindingScaffold = {
  kind: "create-file";
  path: string;
  content: string;
};

export type Finding = {
  id: string;
  expectationId: string;
  expectationVersion: number;
  policyKind: "advisory" | "convention";
  conventionId?: string;
  severity: FindingSeverity;
  state: FindingState;
  disposition: FindingDisposition;
  suppressionReason?: string;
  subject: FindingSubject;
  requirement: FindingRequirement;
  message: string;
  evidence: FindingEvidence[];
  relatedFiles: string[];
  verification: string[][];
  relationships: FindingRelationship[];
  scaffold?: FindingScaffold;
};

export type ExpectationSuppression = {
  id?: string;
  expectation?: string;
  subject?: string;
  reason: string;
};

export type RepositoryInvariant = {
  id: string;
  scope: string;
  statement: string;
  verification?: string[][];
};

export type ExpectationConfig = {
  schemaVersion: 1;
  baseline?: string[];
  suppressions?: ExpectationSuppression[];
  invariants?: RepositoryInvariant[];
  enforcement?: Record<string, FindingSeverity>;
};

export type ExpectationRegistryEntry = {
  id: string;
  version: number;
  description: string;
  defaultSeverity: FindingSeverity;
  policyKind: "advisory" | "convention";
  conventionId?: string;
};

export type ReconciliationReport = {
  orphanedBaseline: string[];
  staleSuppressions: Array<{ index: number; reason: string }>;
  unknownExpectations: string[];
  duplicateBaseline: string[];
  duplicateSuppressions: number[];
  duplicateInvariants: string[];
};

export type ExpectationOperation = "findings" | "finding" | "baseline" | "scaffold";

export type ExpectationEnvelope = {
  schemaVersion: 1;
  operation: ExpectationOperation;
  status: ResultStatus;
  durationMs: number;
  data: Record<string, unknown>;
  diagnostics: Array<{ code?: string; message: string; path?: string }>;
};

export const expectationConfigName = ".coding-tooling.expectations.json";
export const findingIdPattern = /^CT-[A-F0-9]{12}$/;
const severities = new Set<FindingSeverity>(["info", "warning", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

export function loadExpectationConfig(
  root: string,
  configuredPath = expectationConfigName,
): ExpectationConfig {
  const path = join(root, configuredPath);
  if (!existsSync(path)) return { schemaVersion: 1 };
  const value = readJson<unknown>(path);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`${configuredPath} must use schemaVersion 1`);
  }

  const baseline = assertStringArray(value.baseline, `${configuredPath}.baseline`);
  if (baseline?.some((id) => !findingIdPattern.test(id))) {
    throw new Error(`${configuredPath}.baseline contains an invalid finding ID`);
  }

  let suppressions: ExpectationSuppression[] | undefined;
  if (value.suppressions !== undefined) {
    if (!Array.isArray(value.suppressions)) {
      throw new Error(`${configuredPath}.suppressions must be an array`);
    }
    suppressions = value.suppressions.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.reason !== "string" ||
        !item.reason.trim() ||
        (item.id !== undefined && typeof item.id !== "string") ||
        (item.expectation !== undefined && typeof item.expectation !== "string") ||
        (item.subject !== undefined && typeof item.subject !== "string") ||
        (item.id === undefined && item.expectation === undefined)
      ) {
        throw new Error(`${configuredPath}.suppressions[${index}] is invalid`);
      }
      if (typeof item.id === "string" && !findingIdPattern.test(item.id)) {
        throw new Error(`${configuredPath}.suppressions[${index}].id is invalid`);
      }
      return {
        id: item.id as string | undefined,
        expectation: item.expectation as string | undefined,
        subject: item.subject as string | undefined,
        reason: item.reason,
      };
    });
  }

  let invariants: RepositoryInvariant[] | undefined;
  if (value.invariants !== undefined) {
    if (!Array.isArray(value.invariants)) {
      throw new Error(`${configuredPath}.invariants must be an array`);
    }
    invariants = value.invariants.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.scope !== "string" ||
        !item.scope ||
        typeof item.statement !== "string" ||
        !item.statement
      ) {
        throw new Error(`${configuredPath}.invariants[${index}] is invalid`);
      }
      let verification: string[][] | undefined;
      if (item.verification !== undefined) {
        if (
          !Array.isArray(item.verification) ||
          !item.verification.every(
            (command) =>
              Array.isArray(command) &&
              command.length > 0 &&
              command.every((part) => typeof part === "string" && part.length > 0),
          )
        ) {
          throw new Error(`${configuredPath}.invariants[${index}].verification is invalid`);
        }
        verification = item.verification as string[][];
      }
      return { id: item.id, scope: item.scope, statement: item.statement, verification };
    });
  }

  let enforcement: Record<string, FindingSeverity> | undefined;
  if (value.enforcement !== undefined) {
    if (!isRecord(value.enforcement)) {
      throw new Error(`${configuredPath}.enforcement must be an object`);
    }
    enforcement = {};
    for (const [expectation, severity] of Object.entries(value.enforcement)) {
      if (typeof severity !== "string" || !severities.has(severity as FindingSeverity)) {
        throw new Error(`${configuredPath}.enforcement.${expectation} has invalid severity`);
      }
      enforcement[expectation] = severity as FindingSeverity;
    }
  }

  return { schemaVersion: 1, baseline, suppressions, invariants, enforcement };
}

export function writeExpectationConfig(root: string, config: ExpectationConfig): void {
  writeFileSync(join(root, expectationConfigName), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function semanticFindingId(
  expectationId: string,
  expectationVersion: number,
  subjectKey: string,
  requirementKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${expectationId}@${expectationVersion}\0${subjectKey}\0${requirementKey}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `CT-${digest}`;
}

export function matchingSuppression(
  finding: Pick<Finding, "id" | "expectationId" | "subject">,
  config: ExpectationConfig,
): ExpectationSuppression | undefined {
  return (config.suppressions ?? []).find((suppression) => {
    if (suppression.id && suppression.id !== finding.id) return false;
    if (suppression.expectation && suppression.expectation !== finding.expectationId) return false;
    if (suppression.subject && suppression.subject !== finding.subject.key) return false;
    return true;
  });
}

export function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}
