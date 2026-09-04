import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { foundationAudit } from "./foundation-audit.ts";
import { repositoryMergeReadiness, type RepositoryMergeReadiness } from "./merge-readiness.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { runCommand, type CommandResult } from "./shared.ts";

export const REPOSITORY_EVIDENCE_VERSION = "coding-tooling/repository-evidence/v1" as const;

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;
type FoundationCollector = (root: string) => ResultEnvelope<Record<string, unknown>>;
type MetadataReader = typeof readRepositoryMetadata;
type ReadinessCollector = (
  root: string,
  options?: { run?: Runner },
) => RepositoryMergeReadiness;

export type RepositoryEvidenceOptions = {
  validationReportPath?: string;
  publicContractReportPath?: string;
};

export type RepositoryEvidenceDependencies = {
  run?: Runner;
  collectFoundation?: FoundationCollector;
  readMetadata?: MetadataReader;
  collectMergeReadiness?: ReadinessCollector;
};

type ReportEnvelope = {
  schemaVersion?: unknown;
  operation?: unknown;
  status?: unknown;
  data?: unknown;
};

type ReportReference = {
  path: string;
  sha256: string;
};

type ValidationCheck = { status?: unknown };
type ValidationMissing = { optional?: unknown };
type ValidationData = {
  root?: unknown;
  checks?: unknown;
  results?: unknown;
  missing?: unknown;
};

type PublicContractSummary = {
  discovered?: unknown;
  verified?: unknown;
  unverified?: unknown;
  incompleteDiscovery?: unknown;
  failedEvidence?: unknown;
  unavailableEvidence?: unknown;
  errorEvidence?: unknown;
  verifiedRatio?: unknown;
  strictReady?: unknown;
};

type PublicContractData = {
  revision?: unknown;
  enforcement?: unknown;
  summary?: PublicContractSummary;
};

function resultStatus(value: unknown): ResultStatus | undefined {
  return value === "passed" || value === "failed" || value === "unavailable" || value === "error"
    ? value
    : undefined;
}

function currentRevision(root: string, runner: Runner): string | null {
  const result = runner("git", ["rev-parse", "HEAD"], root);
  if (result.status !== 0) return null;
  const revision = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(revision) ? revision : null;
}

function readReport(root: string, reportPath: string, operation: string): {
  envelope: ReportEnvelope;
  reference: ReportReference;
} {
  const absolute = resolve(root, reportPath);
  const content = readFileSync(absolute);
  const envelope = JSON.parse(content.toString("utf8")) as ReportEnvelope;
  if (envelope.schemaVersion !== 1 || envelope.operation !== operation || !resultStatus(envelope.status)) {
    throw new Error(`${reportPath} is not a coding-tooling ${operation} report envelope`);
  }
  return {
    envelope,
    reference: {
      path: reportPath,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  };
}

function validationEvidence(root: string, reportPath?: string): Record<string, unknown> {
  if (!reportPath) return { state: "not-supplied", producer: "coding-tooling/run/v1" };
  const { envelope, reference } = readReport(root, reportPath, "run");
  const data = (envelope.data ?? {}) as ValidationData;
  if (typeof data.root !== "string" || resolve(data.root) !== resolve(root)) {
    throw new Error(`${reportPath} was produced for a different repository root`);
  }
  const checks = Array.isArray(data.checks) ? (data.checks as ValidationCheck[]) : [];
  const results = Array.isArray(data.results) ? (data.results as ValidationCheck[]) : [];
  const missing = Array.isArray(data.missing) ? (data.missing as ValidationMissing[]) : [];
  const byStatus = (status: ResultStatus) => results.filter((entry) => entry.status === status).length;
  return {
    state: "supplied",
    producer: "coding-tooling/run/v1",
    report: reference,
    status: envelope.status,
    summary: {
      plannedChecks: checks.length,
      completedChecks: results.length,
      passedChecks: byStatus("passed"),
      failedChecks: byStatus("failed"),
      unavailableChecks: byStatus("unavailable"),
      errorChecks: byStatus("error"),
      blockedChecks: Math.max(0, checks.length - results.length),
      missingRequiredCapabilities: missing.filter((entry) => entry.optional === false).length,
    },
  };
}

function publicContractEvidence(
  root: string,
  reportPath: string | undefined,
  revision: string | null,
): Record<string, unknown> {
  if (!reportPath)
    return { state: "not-supplied", producer: "coding-tooling/public-contract/v1" };
  const { envelope, reference } = readReport(root, reportPath, "contract");
  const data = (envelope.data ?? {}) as PublicContractData;
  const reportRevision = typeof data.revision === "string" ? data.revision : null;
  if (revision && reportRevision && reportRevision !== revision) {
    throw new Error(
      `${reportPath} was produced for revision ${reportRevision}, not current revision ${revision}`,
    );
  }
  const summary = data.summary;
  if (!summary || typeof summary !== "object") {
    throw new Error(`${reportPath} does not contain a public-contract summary`);
  }
  const numeric = [
    "discovered",
    "verified",
    "unverified",
    "incompleteDiscovery",
    "failedEvidence",
    "unavailableEvidence",
    "errorEvidence",
  ] as const;
  for (const key of numeric) {
    if (typeof summary[key] !== "number" || !Number.isFinite(summary[key])) {
      throw new Error(`${reportPath} has an invalid public-contract summary.${key}`);
    }
  }
  if (
    summary.verifiedRatio !== null &&
    (typeof summary.verifiedRatio !== "number" || !Number.isFinite(summary.verifiedRatio))
  ) {
    throw new Error(`${reportPath} has an invalid public-contract summary.verifiedRatio`);
  }
  if (typeof summary.strictReady !== "boolean") {
    throw new Error(`${reportPath} has an invalid public-contract summary.strictReady`);
  }
  return {
    state: "supplied",
    producer: "coding-tooling/public-contract/v1",
    report: reference,
    status: envelope.status,
    revision: reportRevision,
    revisionMatchesCurrent: revision === null || reportRevision === null ? null : reportRevision === revision,
    enforcement: typeof data.enforcement === "string" ? data.enforcement : null,
    summary: {
      discovered: summary.discovered,
      verified: summary.verified,
      unverified: summary.unverified,
      incompleteDiscovery: summary.incompleteDiscovery,
      failedEvidence: summary.failedEvidence,
      unavailableEvidence: summary.unavailableEvidence,
      errorEvidence: summary.errorEvidence,
      verifiedRatio: summary.verifiedRatio,
      strictReady: summary.strictReady,
    },
  };
}

export function repositoryEvidenceCommand(
  root: string,
  options: RepositoryEvidenceOptions = {},
  dependencies: RepositoryEvidenceDependencies = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const resolvedRoot = resolve(root);
  const runner = dependencies.run ?? runCommand;
  const collectFoundation = dependencies.collectFoundation ?? foundationAudit;
  const metadataReader = dependencies.readMetadata ?? readRepositoryMetadata;
  const collectMergeReadiness = dependencies.collectMergeReadiness ?? repositoryMergeReadiness;

  try {
    const revision = currentRevision(resolvedRoot, runner);
    const metadataRead = metadataReader(resolvedRoot);
    const foundation = collectFoundation(resolvedRoot);
    const merge = collectMergeReadiness(resolvedRoot, { run: runner });
    const validation = validationEvidence(resolvedRoot, options.validationReportPath);
    const publicContract = publicContractEvidence(
      resolvedRoot,
      options.publicContractReportPath,
      revision,
    );

    const document = {
      schemaVersion: REPOSITORY_EVIDENCE_VERSION,
      repository: {
        root: resolvedRoot,
        name: basename(resolvedRoot),
        revision,
        metadata: metadataRead.metadata ?? null,
        metadataDiagnostics: metadataRead.diagnostics,
      },
      sources: {
        foundation: {
          producer: "coding-tooling/foundation/v1",
          status: foundation.status,
          summary: foundation.data.summary ?? null,
          components: foundation.data.components ?? null,
          diagnostics: foundation.diagnostics,
        },
        merge: {
          producer: "coding-tooling/merge-readiness/v1",
          readiness: merge.readiness,
          blockers: merge.blockers,
          evidence: merge.evidence,
        },
        validation,
        publicContract,
      },
      notes: [
        "This envelope composes evidence; it does not introduce a repository score or new pass/fail threshold.",
        "Missing report inputs remain explicitly not-supplied rather than being interpreted as passing evidence.",
        "Public-contract reports are rejected when their recorded Git revision disagrees with the current repository revision.",
      ],
    };

    return {
      schemaVersion: 1,
      operation: "repository-evidence",
      status: "passed",
      durationMs: Date.now() - started,
      data: { root: resolvedRoot, evidence: document },
      diagnostics: [],
    };
  } catch (error) {
    const diagnostic: Diagnostic = {
      code: "repository-evidence-invalid-source",
      message: error instanceof Error ? error.message : String(error),
    };
    return {
      schemaVersion: 1,
      operation: "repository-evidence",
      status: "error",
      durationMs: Date.now() - started,
      data: { root: resolvedRoot },
      diagnostics: [diagnostic],
    };
  }
}
