import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SCORE_HISTORY_SCHEMA_V1 = "coding-tooling/score-history/v1";
export const SCORE_HISTORY_RETENTION = 1000;
export const SCORE_SCHEMA_V1 = "coding-tooling/repository-score/v1";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") throw new Error("score history timestamp must be an ISO date");
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error(`invalid score history timestamp: ${value}`);
  return new Date(instant).toISOString();
}

function compareHistoryEntries(left, right) {
  const byInstant = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  return byInstant !== 0 ? byInstant : String(left.commit).localeCompare(String(right.commit));
}

function categoryMap(categories) {
  return Object.fromEntries(
    (Array.isArray(categories) ? categories : [])
      .filter((category) => category && typeof category.id === "string")
      .map((category) => [category.id, numberOrNull(category.score)]),
  );
}

function verificationSummary(verification) {
  if (!verification || typeof verification !== "object") return null;
  return {
    status: verification.status ?? "unavailable",
    score: numberOrNull(verification.score),
    plannedChecks: verification.plannedChecks ?? 0,
    passedChecks: verification.passedChecks ?? 0,
    failedChecks: verification.failedChecks ?? 0,
    errorChecks: verification.errorChecks ?? 0,
    blockedChecks: verification.blockedChecks ?? 0,
    missingRequiredCapabilities: verification.missingRequiredCapabilities ?? 0,
  };
}

function compactDiagnostics(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : []).slice(0, 10).map((diagnostic) => ({
    ...(typeof diagnostic?.code === "string" ? { code: diagnostic.code } : {}),
    message: String(diagnostic?.message ?? "unknown score production error").slice(0, 500),
    ...(typeof diagnostic?.path === "string" ? { path: diagnostic.path } : {}),
  }));
}

function errorVerification() {
  return {
    status: "error",
    score: null,
    plannedChecks: 0,
    passedChecks: 0,
    failedChecks: 0,
    errorChecks: 0,
    blockedChecks: 0,
    missingRequiredCapabilities: 0,
  };
}

function snapshotProvenance(metadata) {
  if (
    !metadata?.producerCommit ||
    !metadata?.workflowRunId ||
    !metadata?.workflowRunAttempt ||
    !metadata?.validationTier
  ) {
    throw new Error(
      "producer commit, workflow run id/attempt, and validation tier provenance are required",
    );
  }
  const workflowRunAttempt = Number(metadata.workflowRunAttempt);
  if (!Number.isInteger(workflowRunAttempt) || workflowRunAttempt <= 0) {
    throw new Error("workflow run attempt must be a positive integer");
  }
  return {
    producerCommit: String(metadata.producerCommit),
    workflowRunId: String(metadata.workflowRunId),
    workflowRunAttempt,
    validationTier: String(metadata.validationTier),
  };
}

export function appendScoreHistory(existing, scoreEnvelope, metadata) {
  if (scoreEnvelope?.schemaVersion !== 1 || scoreEnvelope?.operation !== "score") {
    throw new Error("score report is not a coding-tooling score envelope");
  }
  if (!metadata?.repository || !metadata?.commit || !metadata?.timestamp) {
    throw new Error("repository, commit, and timestamp metadata are required");
  }

  const score = scoreEnvelope?.data?.score;
  if (score && score.schemaVersion !== SCORE_SCHEMA_V1) {
    throw new Error(`score report does not contain ${SCORE_SCHEMA_V1}`);
  }
  const scoreProfileVersion = score?.profileVersion ?? scoreEnvelope.profileVersion;
  if (typeof scoreProfileVersion !== "string" || scoreProfileVersion.length === 0) {
    throw new Error("score report does not identify its scoring profile");
  }
  if (!score && scoreEnvelope.status !== "error") {
    throw new Error("score report contains no score and is not an error tombstone");
  }

  const history = existing ?? {
    schemaVersion: SCORE_HISTORY_SCHEMA_V1,
    repository: metadata.repository,
    scoreSchemaVersion: SCORE_SCHEMA_V1,
    retention: SCORE_HISTORY_RETENTION,
    entries: [],
  };
  if (history.schemaVersion !== SCORE_HISTORY_SCHEMA_V1) {
    throw new Error(`unsupported score history schema: ${history.schemaVersion}`);
  }
  if (history.repository !== metadata.repository) {
    throw new Error(`score history belongs to ${history.repository}, not ${metadata.repository}`);
  }

  const provenance = snapshotProvenance(metadata);
  const diagnostics = compactDiagnostics(scoreEnvelope.diagnostics);
  const entry = score
    ? {
        commit: metadata.commit,
        timestamp: canonicalTimestamp(metadata.timestamp),
        scoreProfileVersion,
        provenance,
        score: numberOrNull(score.score),
        rating: score.rating,
        completeness: score.completeness,
        structuralScore: numberOrNull(score.structuralScore),
        verificationScore: numberOrNull(score.verificationScore),
        categories: categoryMap(score.categories),
        verification: verificationSummary(score.verification),
        findings: {
          active: score.findings?.active ?? 0,
          suppressed: score.findings?.suppressed ?? 0,
          verified: score.findings?.verified ?? 0,
        },
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      }
    : {
        commit: metadata.commit,
        timestamp: canonicalTimestamp(metadata.timestamp),
        scoreProfileVersion,
        provenance,
        score: null,
        rating: "unavailable",
        completeness: "unavailable",
        structuralScore: null,
        verificationScore: null,
        categories: {},
        verification: errorVerification(),
        findings: { active: 0, suppressed: 0, verified: 0 },
        diagnostics,
      };

  const entries = (Array.isArray(history.entries) ? history.entries : [])
    .filter((candidate) => candidate?.commit !== entry.commit)
    .map((candidate) => ({ ...candidate, timestamp: canonicalTimestamp(candidate?.timestamp) }))
    .concat(entry)
    .toSorted(compareHistoryEntries)
    .slice(-SCORE_HISTORY_RETENTION);

  return {
    ...history,
    scoreSchemaVersion: SCORE_SCHEMA_V1,
    retention: SCORE_HISTORY_RETENTION,
    entries,
  };
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const historyPath = option(argv, "history");
  const scorePath = option(argv, "score");
  const repository = option(argv, "repository");
  const commit = option(argv, "commit");
  const timestamp = option(argv, "timestamp");
  const producerCommit = option(argv, "producer-commit");
  const workflowRunId = option(argv, "workflow-run-id");
  const workflowRunAttempt = option(argv, "workflow-run-attempt");
  const validationTier = option(argv, "validation-tier");
  if (
    !historyPath ||
    !scorePath ||
    !repository ||
    !commit ||
    !timestamp ||
    !producerCommit ||
    !workflowRunId ||
    !workflowRunAttempt ||
    !validationTier
  ) {
    throw new Error(
      "Usage: append-score-history --history <path> --score <path> --repository <owner/repo> --commit <sha> --timestamp <iso> --producer-commit <sha> --workflow-run-id <id> --workflow-run-attempt <n> --validation-tier <tier>",
    );
  }

  const absoluteHistory = resolve(historyPath);
  const existing = existsSync(absoluteHistory) ? readJson(absoluteHistory) : null;
  const updated = appendScoreHistory(existing, readJson(resolve(scorePath)), {
    repository,
    commit,
    timestamp,
    producerCommit,
    workflowRunId,
    workflowRunAttempt,
    validationTier,
  });
  writeFileSync(absoluteHistory, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) main();
