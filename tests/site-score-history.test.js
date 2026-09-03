import { describe, expect, test } from "bun:test";

import {
  chartPoints,
  HISTORY_SCHEMA,
  latestEntry,
  normalizeHistory,
  scoreDelta,
  scoreProfileChanged,
  shortCommit,
} from "../site/score/model.js";

const SCORE_PROFILE = "coding-tooling/repository-score-profile/v1";

const history = {
  schemaVersion: HISTORY_SCHEMA,
  repository: "moritzbrantner/coding-tooling",
  entries: [
    {
      commit: "bbbbbbbb22222222",
      timestamp: "2026-09-03T12:00:00Z",
      scoreProfileVersion: SCORE_PROFILE,
      score: 90,
    },
    {
      commit: "aaaaaaaa11111111",
      timestamp: "2026-09-02T12:00:00Z",
      scoreProfileVersion: SCORE_PROFILE,
      score: 80,
    },
  ],
};

describe("score history dashboard model", () => {
  test("normalizes chronological history and exposes the latest commit", () => {
    const normalized = normalizeHistory(history);

    expect(normalized.entries.map((entry) => entry.score)).toEqual([80, 90]);
    expect(latestEntry(normalized)?.score).toBe(90);
    expect(scoreDelta(normalized.entries)).toBe(10);
    expect(scoreProfileChanged(normalized.entries)).toBe(false);
    expect(shortCommit(normalized.entries[0].commit)).toBe("aaaaaaaa");
  });

  test("withholds a delta when the scoring profile changes", () => {
    const normalized = normalizeHistory({
      ...history,
      entries: history.entries.map((entry, index) =>
        index === 0 ? { ...entry, scoreProfileVersion: "coding-tooling/repository-score-profile/v2" } : entry,
      ),
    });

    expect(scoreProfileChanged(normalized.entries)).toBe(true);
    expect(scoreDelta(normalized.entries)).toBeNull();
  });

  test("maps score values into a bounded chart coordinate system", () => {
    const points = chartPoints(normalizeHistory(history).entries);

    expect(points).toHaveLength(2);
    expect(points[0].x).toBe(24);
    expect(points[1].x).toBe(696);
    expect(points[0].y).toBeGreaterThan(points[1].y);
    expect(points[0].scoreProfileVersion).toBe(SCORE_PROFILE);
  });

  test("rejects an incompatible history schema", () => {
    expect(() => normalizeHistory({ ...history, schemaVersion: "other/v1" })).toThrow(
      HISTORY_SCHEMA,
    );
  });
});
