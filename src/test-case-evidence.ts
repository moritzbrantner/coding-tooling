import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Capability } from "./model.ts";
import { readJson, relativePosix } from "./shared.ts";

export const testCaseEvidenceEnvironment = {
  path: "CODING_TOOLING_CASE_EVIDENCE_PATH",
  runId: "CODING_TOOLING_CASE_EVIDENCE_RUN_ID",
  revision: "CODING_TOOLING_CASE_EVIDENCE_REVISION",
  capability: "CODING_TOOLING_CASE_EVIDENCE_CAPABILITY",
  component: "CODING_TOOLING_CASE_EVIDENCE_COMPONENT",
} as const;

export type TestCaseOutcome = "passed" | "failed" | "skipped" | "todo";

export type TestCaseEvidenceCase = {
  id: string;
  outcome: TestCaseOutcome;
};

export type TestCaseEvidenceArtifact = {
  schemaVersion: 1;
  runId: string;
  revision: string;
  capability: Capability;
  component: string;
  cases: TestCaseEvidenceCase[];
};

export type PreparedTestCaseEvidenceRun = {
  runId: string;
  absolutePath: string;
  path: string;
  revision: string;
  capability: Capability;
  component: string;
  environment: Record<string, string>;
};

export type TestCaseEvidenceReadResult =
  | {
      status: "available";
      artifact: TestCaseEvidenceArtifact;
      cases: Map<string, TestCaseOutcome>;
    }
  | {
      status: "missing" | "invalid";
      reason: string;
    };

const outcomes = new Set<TestCaseOutcome>(["passed", "failed", "skipped", "todo"]);

export function prepareTestCaseEvidenceRun(
  root: string,
  revision: string,
  capability: Capability,
  component: string,
): PreparedTestCaseEvidenceRun {
  const runId = randomUUID();
  const absolutePath = join(
    root,
    ".artifacts",
    "coding-tooling",
    "test-case-evidence",
    `${runId}.json`,
  );
  mkdirSync(dirname(absolutePath), { recursive: true });
  return {
    runId,
    absolutePath,
    path: relativePosix(root, absolutePath),
    revision,
    capability,
    component,
    environment: {
      [testCaseEvidenceEnvironment.path]: absolutePath,
      [testCaseEvidenceEnvironment.runId]: runId,
      [testCaseEvidenceEnvironment.revision]: revision,
      [testCaseEvidenceEnvironment.capability]: capability,
      [testCaseEvidenceEnvironment.component]: component,
    },
  };
}

export function withTestCaseEvidenceEnvironment<T>(
  environment: Record<string, string>,
  execute: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return execute();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function readTestCaseEvidence(
  prepared: PreparedTestCaseEvidenceRun,
): TestCaseEvidenceReadResult {
  if (!existsSync(prepared.absolutePath)) {
    return { status: "missing", reason: "test-case-evidence-artifact-not-produced" };
  }
  const artifact = readJson<TestCaseEvidenceArtifact>(prepared.absolutePath);
  if (!artifact || artifact.schemaVersion !== 1) {
    return { status: "invalid", reason: "test-case-evidence-schema-invalid" };
  }
  if (artifact.runId !== prepared.runId) {
    return { status: "invalid", reason: "test-case-evidence-run-id-mismatch" };
  }
  if (artifact.revision !== prepared.revision) {
    return { status: "invalid", reason: "test-case-evidence-revision-mismatch" };
  }
  if (artifact.capability !== prepared.capability) {
    return { status: "invalid", reason: "test-case-evidence-capability-mismatch" };
  }
  if (artifact.component !== prepared.component) {
    return { status: "invalid", reason: "test-case-evidence-component-mismatch" };
  }
  if (!Array.isArray(artifact.cases)) {
    return { status: "invalid", reason: "test-case-evidence-cases-invalid" };
  }

  const cases = new Map<string, TestCaseOutcome>();
  for (const item of artifact.cases) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || !outcomes.has(item.outcome)) {
      return { status: "invalid", reason: "test-case-evidence-case-invalid" };
    }
    if (cases.has(item.id)) {
      return { status: "invalid", reason: `test-case-evidence-duplicate-case:${item.id}` };
    }
    cases.set(item.id, item.outcome);
  }
  return { status: "available", artifact, cases };
}
