import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SCORE_HISTORY_SCHEMA_V1 = "coding-tooling/score-history/v1";
export const SCORE_HISTORY_RETENTION = 1000;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
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

export function appendScoreHistory(existing, scoreEnvelope, metadata) {
  if (scoreEnvelope?.schemaVersion !== 1 || scoreEnvelope?.operation !== "score") {
    throw new Error("score report is not a coding-tooling score envelope");
  }
  const score = scoreEnvelope?.data?.score;
  if (!score || score.schemaVersion !== "coding-tooling/repository-score/v1") {
    throw new Error("score report does not contain coding-tooling/repository-score/v1");
  }
  if (typeof score.profileVersion !== "string" || score.profileVersion.length === 0) {
    throw new Error("score report does not identify its scoring profile");
  }
  if (!metadata?.repository || !metadata?.commit || !metadata?.timestamp) {
    throw new Error("repository, commit, and timestamp metadata are required");
  }

  const history = existing ?? {
    schemaVersion: SCORE_HISTORY_SCHEMA_V1,
    repository: metadata.repository,
    scoreSchemaVersion: score.schemaVersion,
    retention: SCORE_HISTORY_RETENTION,
    entries: [],
  };
  if (history.schemaVersion !== SCORE_HISTORY_SCHEMA_V1) {
    throw new Error(`unsupported score history schema: ${history.schemaVersion}`);
  }
  if (history.repository !== metadata.repository) {
    throw new Error(`score history belongs to ${history.repository}, not ${metadata.repository}`);
  }

  const entry = {
    commit: metadata.commit,
    timestamp: metadata.timestamp,
    scoreProfileVersion: score.profileVersion,
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
  };

  const entries = [...(Array.isArray(history.entries) ? history.entries : [])]
    .filter((candidate) => candidate?.commit !== entry.commit)
    .concat(entry)
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
    .slice(-SCORE_HISTORY_RETENTION);

  return {
    ...history,
    scoreSchemaVersion: score.schemaVersion,
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
  if (!historyPath || !scorePath || !repository || !commit || !timestamp) {
    throw new Error(
      "Usage: append-score-history --history <path> --score <path> --repository <owner/repo> --commit <sha> --timestamp <iso>",
    );
  }

  const absoluteHistory = resolve(historyPath);
  const existing = existsSync(absoluteHistory) ? readJson(absoluteHistory) : null;
  const updated = appendScoreHistory(existing, readJson(resolve(scorePath)), {
    repository,
    commit,
    timestamp,
  });
  writeFileSync(absoluteHistory, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) main();
