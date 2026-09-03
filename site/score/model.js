export const HISTORY_SCHEMA = "coding-tooling/score-history/v1";

export function normalizeHistory(document) {
  if (!document || document.schemaVersion !== HISTORY_SCHEMA) {
    throw new Error(`Expected ${HISTORY_SCHEMA}`);
  }
  const entries = (Array.isArray(document.entries) ? document.entries : [])
    .filter((entry) => entry && typeof entry.commit === "string")
    .map((entry) => ({
      ...entry,
      score: Number.isFinite(entry.score) ? entry.score : null,
      structuralScore: Number.isFinite(entry.structuralScore) ? entry.structuralScore : null,
      verificationScore: Number.isFinite(entry.verificationScore) ? entry.verificationScore : null,
    }))
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
  return { ...document, entries };
}

export function latestEntry(history) {
  return history.entries.at(-1) ?? null;
}

export function shortCommit(commit) {
  return commit.slice(0, 8);
}

export function scoreDelta(entries) {
  const scored = entries.filter((entry) => entry.score !== null);
  if (scored.length < 2) return null;
  return scored.at(-1).score - scored.at(-2).score;
}

export function chartPoints(entries, width = 720, height = 240, padding = 24) {
  const scored = entries.filter((entry) => entry.score !== null);
  if (scored.length === 0) return [];
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  return scored.map((entry, index) => ({
    ...entry,
    x: scored.length === 1 ? width / 2 : padding + (index / (scored.length - 1)) * usableWidth,
    y: padding + ((100 - entry.score) / 100) * usableHeight,
  }));
}
