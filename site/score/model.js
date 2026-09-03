export const HISTORY_SCHEMA = "coding-tooling/score-history/v1";

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

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
      definitionFingerprint:
        typeof entry.definitionFingerprint === "string" ? entry.definitionFingerprint : null,
      score: finiteOrNull(entry.score),
      structuralScore: finiteOrNull(entry.structuralScore),
      verificationScore: finiteOrNull(entry.verificationScore),
      audits: Array.isArray(entry.audits) ? entry.audits : [],
    }))
    .toSorted(compareHistoryEntries);
  return {
    ...document,
    definitions:
      document.definitions && typeof document.definitions === "object" ? document.definitions : {},
    entries,
  };
}

export function latestEntry(history) {
  return history.entries.at(-1) ?? null;
}

export function shortCommit(commit) {
  return commit.slice(0, 8);
}

export function shortFingerprint(fingerprint) {
  if (typeof fingerprint !== "string") return "unknown";
  return fingerprint.startsWith("sha256:") ? fingerprint.slice(7, 19) : fingerprint.slice(0, 12);
}

export function scoreDelta(entries) {
  const latest = entries.at(-1);
  if (latest?.score === null || !latest?.change?.comparable) return null;
  return finiteOrNull(latest.change.scoreDelta);
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

function sameComparisonIdentity(left, right) {
  return (
    typeof left?.scoreProfileVersion === "string" &&
    left.scoreProfileVersion === right?.scoreProfileVersion &&
    typeof left?.definitionFingerprint === "string" &&
    left.definitionFingerprint === right?.definitionFingerprint
  );
}

export function chartSegments(entries, width = 720, height = 240, padding = 24) {
  const points = chartPoints(entries, width, height, padding);
  const pointByCommit = new Map(points.map((point) => [point.commit, point]));
  const segments = [];
  let segment = [];
  for (const entry of entries) {
    const point = pointByCommit.get(entry.commit);
    if (!point) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      continue;
    }
    const previous = segment.at(-1);
    if (previous && !sameComparisonIdentity(previous, point)) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function nonZero(value) {
  return Number.isFinite(value) && value !== 0;
}

export function changeDrivers(entry) {
  const change = entry?.change;
  if (!change) return [];
  if (!change.comparable) {
    const labels = {
      "first-snapshot": "First snapshot in history",
      "profile-changed": "Scoring profile changed; numeric deltas are not comparable",
      "profile-unknown": "Prior scoring profile is unknown; numeric deltas are not comparable",
      "definition-changed": "Score definition changed; numeric deltas are not comparable",
      "definition-unknown": "Score definition is unknown across this boundary",
    };
    return [
      {
        kind: "boundary",
        id: change.status,
        label: labels[change.status] ?? "Score comparison unavailable",
        delta: null,
      },
    ];
  }

  const drivers = [];
  if (nonZero(change.verification?.scoreDelta)) {
    drivers.push({
      kind: "verification",
      id: "verification",
      label: "Verification",
      delta: change.verification.scoreDelta,
    });
  }
  for (const audit of Array.isArray(change.auditDeltas) ? change.auditDeltas : []) {
    if (
      nonZero(audit.scoreDelta) ||
      nonZero(audit.failedSubjectsDelta) ||
      nonZero(audit.activeFindingsDelta) ||
      nonZero(audit.suppressedFindingsDelta) ||
      nonZero(audit.verifiedFindingsDelta)
    ) {
      drivers.push({
        kind: "audit",
        id: audit.id,
        label: audit.id.replaceAll("-", " "),
        category: audit.category,
        delta: finiteOrNull(audit.scoreDelta),
        failedSubjectsDelta: finiteOrNull(audit.failedSubjectsDelta),
        activeFindingsDelta: finiteOrNull(audit.activeFindingsDelta),
      });
    }
  }

  return drivers.toSorted((left, right) => {
    const deltaOrder = Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0);
    return deltaOrder !== 0 ? deltaOrder : left.id.localeCompare(right.id);
  });
}
