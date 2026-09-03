export const HISTORY_SCHEMA = "coding-tooling/score-history/v1";

function canonicalTimestamp(value) {
  if (typeof value !== "string") throw new Error("Score history timestamp must be an ISO date");
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error(`Invalid score history timestamp: ${value}`);
  return new Date(instant).toISOString();
}

function compareHistoryEntries(left, right) {
  const byInstant = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  return byInstant !== 0 ? byInstant : left.commit.localeCompare(right.commit);
}

function count(value) {
  return Number.isFinite(value) ? value : 0;
}

export function normalizeHistory(document) {
  if (!document || document.schemaVersion !== HISTORY_SCHEMA) {
    throw new Error(`Expected ${HISTORY_SCHEMA}`);
  }
  const entries = (Array.isArray(document.entries) ? document.entries : [])
    .filter((entry) => entry && typeof entry.commit === "string")
    .map((entry) => ({
      ...entry,
      timestamp: canonicalTimestamp(entry.timestamp),
      scoreProfileVersion:
        typeof entry.scoreProfileVersion === "string" ? entry.scoreProfileVersion : null,
      score: Number.isFinite(entry.score) ? entry.score : null,
      structuralScore: Number.isFinite(entry.structuralScore) ? entry.structuralScore : null,
      verificationScore: Number.isFinite(entry.verificationScore) ? entry.verificationScore : null,
    }))
    .toSorted(compareHistoryEntries);
  return { ...document, entries };
}

export function latestEntry(history) {
  return history.entries.at(-1) ?? null;
}

export function shortCommit(commit) {
  return commit.slice(0, 8);
}

function scoredEntries(entries) {
  return entries.filter((entry) => entry.score !== null);
}

export function scoreProfileChanged(entries) {
  if (entries.at(-1)?.score === null) return false;
  const scored = scoredEntries(entries);
  if (scored.length < 2) return false;
  return scored.at(-1).scoreProfileVersion !== scored.at(-2).scoreProfileVersion;
}

export function scoreDelta(entries) {
  if (entries.at(-1)?.score === null) return null;
  const scored = scoredEntries(entries);
  if (scored.length < 2 || scoreProfileChanged(entries)) return null;
  return scored.at(-1).score - scored.at(-2).score;
}

export function verificationEvidence(entry) {
  const verification = entry?.verification;
  if (!verification || typeof verification !== "object") return "unavailable";
  const status = String(verification.status ?? "unavailable");
  const passed = count(verification.passedChecks);
  const failed = count(verification.failedChecks);
  const errors = count(verification.errorChecks);
  const blocked = count(verification.blockedChecks);
  const missing = count(verification.missingRequiredCapabilities);
  const parts = [status];
  if (
    count(verification.plannedChecks) > 0 ||
    passed > 0 ||
    failed > 0 ||
    errors > 0 ||
    blocked > 0
  ) {
    parts.push(`${passed} passed`);
  }
  if (failed > 0) parts.push(`${failed} failed`);
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (missing > 0) parts.push(`${missing} required missing`);
  return parts.join(" · ");
}

export function diagnosticText(entry) {
  const diagnostics = Array.isArray(entry?.diagnostics) ? entry.diagnostics : [];
  return diagnostics
    .map((diagnostic) => {
      const code = typeof diagnostic?.code === "string" ? `${diagnostic.code}: ` : "";
      return `${code}${String(diagnostic?.message ?? "unknown error")}`;
    })
    .join(" · ");
}

export function chartPoints(entries, width = 720, height = 240, padding = 24) {
  const scored = scoredEntries(entries);
  if (scored.length === 0) return [];
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  return scored.map((entry, index) => ({
    ...entry,
    x: scored.length === 1 ? width / 2 : padding + (index / (scored.length - 1)) * usableWidth,
    y: padding + ((100 - entry.score) / 100) * usableHeight,
  }));
}
