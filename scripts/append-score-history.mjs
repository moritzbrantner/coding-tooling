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

function numberDelta(before, after) {
  return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
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

function compactDiagnostics(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : []).slice(0, 10).map((diagnostic) => ({
    ...(typeof diagnostic?.code === "string" ? { code: diagnostic.code } : {}),
    message: String(diagnostic?.message ?? "unknown score production error").slice(0, 500),
    ...(typeof diagnostic?.path === "string" ? { path: diagnostic.path } : {}),
  }));
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

function auditSummary(audits) {
  return (Array.isArray(audits) ? audits : [])
    .filter((audit) => audit && typeof audit.id === "string")
    .map((audit) => ({
      id: audit.id,
      version: audit.version ?? 0,
      description: audit.description ?? audit.id,
      category: audit.category ?? "other",
      severity: audit.severity ?? "warning",
      coverageStatus: audit.coverageStatus ?? "unavailable",
      coverageSubjects: audit.coverageSubjects ?? 0,
      scoreModel: audit.scoreModel ?? "unavailable",
      subjects: numberOrNull(audit.subjects),
      failedSubjects: numberOrNull(audit.failedSubjects),
      activeFindings: audit.activeFindings ?? 0,
      suppressedFindings: audit.suppressedFindings ?? 0,
      verifiedFindings: audit.verifiedFindings ?? 0,
      score: numberOrNull(audit.score),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function definitionFromScore(score) {
  const definition = score?.definition;
  if (
    !definition ||
    definition.schemaVersion !== "coding-tooling/repository-score-definition/v1" ||
    typeof definition.fingerprint !== "string" ||
    !definition.fingerprint.startsWith("sha256:")
  ) {
    throw new Error(
      "score report does not contain a valid repository score definition fingerprint",
    );
  }
  return definition;
}

function mapDeltas(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .toSorted()
    .map((id) => ({
      id,
      before: numberOrNull(before?.[id]),
      after: numberOrNull(after?.[id]),
      delta: numberDelta(before?.[id], after?.[id]),
    }))
    .filter((change) => change.before !== change.after);
}

function auditDeltas(beforeAudits, afterAudits) {
  const before = new Map(
    (Array.isArray(beforeAudits) ? beforeAudits : []).map((audit) => [audit.id, audit]),
  );
  const after = new Map(
    (Array.isArray(afterAudits) ? afterAudits : []).map((audit) => [audit.id, audit]),
  );
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids]
    .toSorted()
    .map((id) => {
      const prior = before.get(id);
      const current = after.get(id);
      return {
        id,
        category: current?.category ?? prior?.category ?? "other",
        before: numberOrNull(prior?.score),
        after: numberOrNull(current?.score),
        scoreDelta: numberDelta(prior?.score, current?.score),
        subjectsDelta: numberDelta(prior?.subjects, current?.subjects),
        failedSubjectsDelta: numberDelta(prior?.failedSubjects, current?.failedSubjects),
        activeFindingsDelta: numberDelta(prior?.activeFindings, current?.activeFindings),
        suppressedFindingsDelta: numberDelta(
          prior?.suppressedFindings,
          current?.suppressedFindings,
        ),
        verifiedFindingsDelta: numberDelta(prior?.verifiedFindings, current?.verifiedFindings),
      };
    })
    .filter((change) =>
      [
        change.before !== change.after,
        change.subjectsDelta !== 0 && change.subjectsDelta !== null,
        change.failedSubjectsDelta !== 0 && change.failedSubjectsDelta !== null,
        change.activeFindingsDelta !== 0 && change.activeFindingsDelta !== null,
        change.suppressedFindingsDelta !== 0 && change.suppressedFindingsDelta !== null,
        change.verifiedFindingsDelta !== 0 && change.verifiedFindingsDelta !== null,
      ].some(Boolean),
    );
}

function verificationDelta(before, after) {
  if (!before && !after) return null;
  return {
    scoreDelta: numberDelta(before?.score, after?.score),
    passedChecksDelta: numberDelta(before?.passedChecks, after?.passedChecks),
    failedChecksDelta: numberDelta(before?.failedChecks, after?.failedChecks),
    errorChecksDelta: numberDelta(before?.errorChecks, after?.errorChecks),
    blockedChecksDelta: numberDelta(before?.blockedChecks, after?.blockedChecks),
    missingRequiredCapabilitiesDelta: numberDelta(
      before?.missingRequiredCapabilities,
      after?.missingRequiredCapabilities,
    ),
  };
}

export function attributeScoreChange(previous, current) {
  const base = {
    priorCommit: previous?.commit ?? null,
    scoreDelta: numberDelta(previous?.score, current?.score),
    structuralScoreDelta: numberDelta(previous?.structuralScore, current?.structuralScore),
    verification: verificationDelta(previous?.verification, current?.verification),
    categoryDeltas: [],
    auditDeltas: [],
  };
  if (!previous) return { ...base, status: "first-snapshot", comparable: false };
  if (!previous.scoreProfileVersion || !current.scoreProfileVersion) {
    return { ...base, status: "profile-unknown", comparable: false };
  }
  if (previous.scoreProfileVersion !== current.scoreProfileVersion) {
    return { ...base, status: "profile-changed", comparable: false };
  }
  if (!previous.definitionFingerprint || !current.definitionFingerprint) {
    return { ...base, status: "definition-unknown", comparable: false };
  }
  if (previous.definitionFingerprint !== current.definitionFingerprint) {
    return { ...base, status: "definition-changed", comparable: false };
  }
  return {
    ...base,
    status: "comparable",
    comparable: true,
    categoryDeltas: mapDeltas(previous.categories, current.categories),
    auditDeltas: auditDeltas(previous.audits, current.audits),
  };
}

function withAttribution(entries) {
  return entries.map((entry, index) => ({
    ...entry,
    change: attributeScoreChange(index === 0 ? null : entries[index - 1], entry),
  }));
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
  if (
    score?.profileVersion &&
    scoreEnvelope.profileVersion &&
    score.profileVersion !== scoreEnvelope.profileVersion
  ) {
    throw new Error("score document profile does not match the score envelope profile");
  }
  if (!score && scoreEnvelope.status !== "error") {
    throw new Error("score report contains no score and is not an error tombstone");
  }

  const definition = score ? definitionFromScore(score) : null;
  if (definition && definition.profileVersion !== scoreProfileVersion) {
    throw new Error("score definition profile does not match the score profile");
  }

  const history = existing ?? {
    schemaVersion: SCORE_HISTORY_SCHEMA_V1,
    repository: metadata.repository,
    scoreSchemaVersion: SCORE_SCHEMA_V1,
    retention: SCORE_HISTORY_RETENTION,
    definitions: {},
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
        definitionFingerprint: definition.fingerprint,
        provenance,
        score: numberOrNull(score.score),
        rating: score.rating,
        completeness: score.completeness,
        structuralScore: numberOrNull(score.structuralScore),
        verificationScore: numberOrNull(score.verificationScore),
        categories: categoryMap(score.categories),
        audits: auditSummary(score.audits),
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
        definitionFingerprint: null,
        provenance,
        score: null,
        rating: "unavailable",
        completeness: "unavailable",
        structuralScore: null,
        verificationScore: null,
        categories: {},
        audits: [],
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

  const definitions =
    history.definitions && typeof history.definitions === "object" ? history.definitions : {};

  return {
    ...history,
    scoreSchemaVersion: SCORE_SCHEMA_V1,
    retention: SCORE_HISTORY_RETENTION,
    definitions: definition
      ? {
          ...definitions,
          [definition.fingerprint]: definition,
        }
      : definitions,
    entries: withAttribution(entries),
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
