import { describe, expect, test } from "bun:test";

import {
  changeDrivers,
  chartPoints,
  chartSegments,
  diagnosticText,
  HISTORY_SCHEMA,
  latestEntry,
  normalizeHistory,
  scoreDelta,
  shortCommit,
  shortFingerprint,
  verificationEvidence,
} from "../site/score/model.js";

const SCORE_PROFILE = "coding-tooling/repository-score-profile/v1";
const fingerprint = `sha256:${"1".repeat(64)}`;
const otherFingerprint = `sha256:${"2".repeat(64)}`;

const history = {
  schemaVersion: HISTORY_SCHEMA,
  repository: "moritzbrantner/coding-tooling",
  definitions: {},
  entries: [
    {
      commit: "bbbbbbbb22222222",
      timestamp: "2026-09-03T12:00:00Z",
      scoreProfileVersion: SCORE_PROFILE,
      definitionFingerprint: fingerprint,
      score: 90,
      verification: {
        status: "failed",
        plannedChecks: 4,
        passedChecks: 3,
        failedChecks: 1,
        errorChecks: 0,
        blockedChecks: 0,
        missingRequiredCapabilities: 0,
      },
      change: {
        comparable: true,
        status: "comparable",
        scoreDelta: 10,
        verification: { scoreDelta: 25 },
        auditDeltas: [
          {
            id: "typescript-source-test",
            category: "testing",
            scoreDelta: -5,
            failedSubjectsDelta: 1,
            activeFindingsDelta: 1,
          },
        ],
      },
    },
    {
      commit: "aaaaaaaa11111111",
      timestamp: "2026-09-02T12:00:00Z",
      scoreProfileVersion: SCORE_PROFILE,
      definitionFingerprint: fingerprint,
      score: 80,
      verification: {
        status: "passed",
        plannedChecks: 4,
        passedChecks: 4,
        failedChecks: 0,
        errorChecks: 0,
        blockedChecks: 0,
        missingRequiredCapabilities: 0,
      },
      change: { comparable: false, status: "first-snapshot", scoreDelta: null },
    },
  ],
};

describe("score history dashboard model", () => {
  test("normalizes chronological history and exposes the latest comparable delta", () => {
    const normalized = normalizeHistory(history);

    expect(normalized.entries.map((entry) => entry.score)).toEqual([80, 90]);
    expect(normalized.entries[0].timestamp).toBe("2026-09-02T12:00:00.000Z");
    expect(latestEntry(normalized)?.score).toBe(90);
    expect(scoreDelta(normalized.entries)).toBe(10);
    expect(normalized.entries[0].scoreProfileVersion).toBe(SCORE_PROFILE);
    expect(shortCommit(normalized.entries[0].commit)).toBe("aaaaaaaa");
    expect(shortFingerprint(fingerprint)).toBe("111111111111");
  });

  test("describes failed verification with check counts", () => {
    const normalized = normalizeHistory(history);
    expect(verificationEvidence(latestEntry(normalized))).toBe("failed · 3 passed · 1 failed");
  });

  test("keeps an unscored error tombstone latest without reusing an older delta", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        ...history.entries,
        {
          commit: "cccccccc33333333",
          timestamp: "2026-09-04T12:00:00Z",
          scoreProfileVersion: SCORE_PROFILE,
          definitionFingerprint: null,
          score: null,
          structuralScore: null,
          verificationScore: null,
          verification: { status: "error" },
          diagnostics: [
            {
              code: "repository-verification-score-failed",
              message: "history-run.json could not be read",
            },
          ],
          change: { comparable: false, status: "definition-unknown", scoreDelta: null },
        },
      ],
    });

    const latest = latestEntry(normalized);
    expect(latest?.commit).toBe("cccccccc33333333");
    expect(latest?.score).toBeNull();
    expect(scoreDelta(normalized.entries)).toBeNull();
    expect(verificationEvidence(latest)).toBe("error");
    expect(diagnosticText(latest)).toContain("repository-verification-score-failed");
    expect(changeDrivers(latest)).toEqual([
      expect.objectContaining({ kind: "boundary", id: "definition-unknown", delta: null }),
    ]);
  });

  test("maps score values into a bounded chart coordinate system", () => {
    const points = chartPoints(normalizeHistory(history).entries);

    expect(points).toHaveLength(2);
    expect(points[0].x).toBe(24);
    expect(points[1].x).toBe(696);
    expect(points[0].y).toBeGreaterThan(points[1].y);
  });

  test("breaks chart series when adjacent exact score definitions differ", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        history.entries[1],
        history.entries[0],
        {
          ...history.entries[0],
          commit: "cccccccc33333333",
          timestamp: "2026-09-04T12:00:00Z",
          definitionFingerprint: otherFingerprint,
          score: 85,
        },
      ],
    });

    expect(chartSegments(normalized.entries).map((segment) => segment.length)).toEqual([2, 1]);
  });

  test("breaks chart series when the coarse scoring profile changes", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        history.entries[1],
        history.entries[0],
        {
          ...history.entries[0],
          commit: "cccccccc33333333",
          timestamp: "2026-09-04T12:00:00Z",
          scoreProfileVersion: "coding-tooling/repository-score-profile/v2",
          score: 85,
        },
      ],
    });

    expect(chartSegments(normalized.entries).map((segment) => segment.length)).toEqual([2, 1]);
  });

  test("breaks chart series across an unscored tombstone even when surrounding identities match", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        history.entries[1],
        {
          commit: "cccccccc33333333",
          timestamp: "2026-09-02T18:00:00Z",
          scoreProfileVersion: SCORE_PROFILE,
          definitionFingerprint: null,
          score: null,
          verification: { status: "error" },
        },
        history.entries[0],
      ],
    });

    expect(chartSegments(normalized.entries).map((segment) => segment.length)).toEqual([1, 1]);
  });

  test("turns verification and audit attribution into sorted dashboard drivers", () => {
    const drivers = changeDrivers(latestEntry(normalizeHistory(history)));

    expect(drivers[0]).toEqual(
      expect.objectContaining({ kind: "verification", id: "verification", delta: 25 }),
    );
    expect(drivers[1]).toEqual(
      expect.objectContaining({
        kind: "audit",
        id: "typescript-source-test",
        delta: -5,
        failedSubjectsDelta: 1,
      }),
    );
  });

  test("suppresses numeric deltas across an exact definition boundary", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        history.entries[1],
        {
          ...history.entries[0],
          definitionFingerprint: otherFingerprint,
          change: {
            comparable: false,
            status: "definition-changed",
            scoreDelta: 10,
          },
        },
      ],
    });

    expect(scoreDelta(normalized.entries)).toBeNull();
    expect(changeDrivers(latestEntry(normalized))).toEqual([
      expect.objectContaining({ kind: "boundary", id: "definition-changed", delta: null }),
    ]);
  });

  test("surfaces a scoring-profile boundary explicitly", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        history.entries[1],
        {
          ...history.entries[0],
          scoreProfileVersion: "coding-tooling/repository-score-profile/v2",
          change: {
            comparable: false,
            status: "profile-changed",
            scoreDelta: 10,
          },
        },
      ],
    });

    expect(changeDrivers(latestEntry(normalized))).toEqual([
      expect.objectContaining({ kind: "boundary", id: "profile-changed", delta: null }),
    ]);
  });

  test("orders mixed offsets by their actual instant", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        {
          commit: "aaaaaaaa11111111",
          timestamp: "2026-09-03T23:30:00+02:00",
          scoreProfileVersion: SCORE_PROFILE,
          definitionFingerprint: fingerprint,
          score: 80,
        },
        {
          commit: "bbbbbbbb22222222",
          timestamp: "2026-09-03T22:00:00Z",
          scoreProfileVersion: SCORE_PROFILE,
          definitionFingerprint: fingerprint,
          score: 90,
        },
      ],
    });

    expect(normalized.entries.map((entry) => entry.commit[0])).toEqual(["a", "b"]);
    expect(latestEntry(normalized)?.commit).toBe("bbbbbbbb22222222");
  });

  test("uses commit identity to order equal instants deterministically", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: [
        {
          commit: "bbbbbbbb22222222",
          timestamp: "2026-09-03T23:00:00+02:00",
          scoreProfileVersion: SCORE_PROFILE,
          definitionFingerprint: fingerprint,
          score: 90,
        },
        {
          commit: "aaaaaaaa11111111",
          timestamp: "2026-09-03T21:00:00Z",
          scoreProfileVersion: SCORE_PROFILE,
          definitionFingerprint: fingerprint,
          score: 80,
        },
      ],
    });

    expect(normalized.entries.map((entry) => entry.commit[0])).toEqual(["a", "b"]);
  });

  test("rejects invalid timestamps rather than selecting a false latest commit", () => {
    expect(() =>
      normalizeHistory({
        ...history,
        entries: [{ commit: "aaaaaaaa11111111", timestamp: "bad", score: 80 }],
      }),
    ).toThrow("Invalid score history timestamp");
  });

  test("rejects an incompatible history schema", () => {
    expect(() => normalizeHistory({ ...history, schemaVersion: "other/v1" })).toThrow(
      HISTORY_SCHEMA,
    );
  });
});
