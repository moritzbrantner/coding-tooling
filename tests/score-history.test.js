import { describe, expect, test } from "bun:test";

import {
  appendScoreHistory,
  SCORE_HISTORY_RETENTION,
  SCORE_HISTORY_SCHEMA_V1,
} from "../scripts/append-score-history.mjs";

const SCORE_PROFILE = "coding-tooling/repository-score-profile/v1";

function scoreEnvelope(score = 88) {
  return {
    schemaVersion: 1,
    operation: "score",
    status: "passed",
    durationMs: 10,
    data: {
      root: "/repo",
      score: {
        schemaVersion: "coding-tooling/repository-score/v1",
        profileVersion: SCORE_PROFILE,
        score,
        rating: score >= 90 ? "good" : "needs-improvement",
        completeness: "complete",
        structuralScore: 100,
        verificationScore: 75,
        categories: [
          { id: "testing", score: 100, auditCount: 2 },
          { id: "verification", score: 75, auditCount: 1 },
        ],
        audits: [],
        verification: {
          source: "coding-tooling/run/v1",
          reportPath: ".artifacts/coding-tooling/run.json",
          status: "failed",
          score: 75,
          plannedChecks: 4,
          passedChecks: 3,
          failedChecks: 1,
          errorChecks: 0,
          blockedChecks: 0,
          missingRequiredCapabilities: 0,
        },
        coverage: {},
        findings: { active: 1, suppressed: 0, verified: 2 },
        notes: [],
      },
    },
    diagnostics: [],
  };
}

function errorEnvelope() {
  return {
    schemaVersion: 1,
    operation: "score",
    profileVersion: SCORE_PROFILE,
    status: "error",
    durationMs: 5,
    data: { root: "/repo" },
    diagnostics: [
      {
        code: "repository-verification-score-failed",
        message: "history-run.json could not be read",
        path: ".artifacts/coding-tooling/history-run.json",
      },
    ],
  };
}

const metadata = {
  repository: "moritzbrantner/coding-tooling",
  commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  timestamp: "2026-09-03T18:00:00Z",
};

describe("repository score history", () => {
  test("creates a compact versioned snapshot from a score report", () => {
    const history = appendScoreHistory(null, scoreEnvelope(), metadata);

    expect(history.schemaVersion).toBe(SCORE_HISTORY_SCHEMA_V1);
    expect(history.retention).toBe(SCORE_HISTORY_RETENTION);
    expect(history.entries).toEqual([
      expect.objectContaining({
        commit: metadata.commit,
        timestamp: "2026-09-03T18:00:00.000Z",
        scoreProfileVersion: SCORE_PROFILE,
        score: 88,
        structuralScore: 100,
        verificationScore: 75,
        categories: { testing: 100, verification: 75 },
        verification: expect.objectContaining({ status: "failed", passedChecks: 3 }),
        findings: { active: 1, suppressed: 0, verified: 2 },
      }),
    ]);
  });

  test("retains a score-production error as an unscored commit tombstone", () => {
    const history = appendScoreHistory(null, errorEnvelope(), metadata);

    expect(history.entries).toEqual([
      expect.objectContaining({
        commit: metadata.commit,
        scoreProfileVersion: SCORE_PROFILE,
        score: null,
        rating: "unavailable",
        completeness: "unavailable",
        structuralScore: null,
        verificationScore: null,
        verification: expect.objectContaining({ status: "error", score: null }),
        diagnostics: [expect.objectContaining({ code: "repository-verification-score-failed" })],
      }),
    ]);
  });

  test("replaces an error tombstone when the same commit later scores successfully", () => {
    const failed = appendScoreHistory(null, errorEnvelope(), metadata);
    const recovered = appendScoreHistory(failed, scoreEnvelope(100), metadata);

    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0]?.score).toBe(100);
    expect(recovered.entries[0]?.verification.status).toBe("failed");
    expect(recovered.entries[0]?.diagnostics).toBeUndefined();
  });

  test("rejects an unscored non-error envelope", () => {
    const envelope = { ...errorEnvelope(), status: "unavailable" };
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("not an error tombstone");
  });

  test("rejects score snapshots without a scoring profile", () => {
    const envelope = scoreEnvelope();
    delete envelope.data.score.profileVersion;
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("scoring profile");
  });

  test("replaces a rerun for the same commit instead of duplicating it", () => {
    const first = appendScoreHistory(null, scoreEnvelope(88), metadata);
    const rerun = appendScoreHistory(first, scoreEnvelope(100), metadata);

    expect(rerun.entries).toHaveLength(1);
    expect(rerun.entries[0]?.score).toBe(100);
  });

  test("canonicalizes offsets and sorts by chronological instant", () => {
    const first = appendScoreHistory(null, scoreEnvelope(80), {
      ...metadata,
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timestamp: "2026-09-03T23:30:00+02:00",
    });
    const second = appendScoreHistory(first, scoreEnvelope(90), {
      ...metadata,
      commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      timestamp: "2026-09-03T22:00:00Z",
    });

    expect(second.entries.map((entry) => entry.commit[0])).toEqual(["a", "b"]);
    expect(second.entries.map((entry) => entry.timestamp)).toEqual([
      "2026-09-03T21:30:00.000Z",
      "2026-09-03T22:00:00.000Z",
    ]);
  });

  test("uses commit identity as a deterministic tie-breaker for equal instants", () => {
    const first = appendScoreHistory(null, scoreEnvelope(90), {
      ...metadata,
      commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      timestamp: "2026-09-03T23:00:00+02:00",
    });
    const second = appendScoreHistory(first, scoreEnvelope(90), {
      ...metadata,
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timestamp: "2026-09-03T21:00:00Z",
    });

    expect(second.entries.map((entry) => entry.commit[0])).toEqual(["a", "b"]);
  });

  test("rejects invalid history timestamps", () => {
    expect(() =>
      appendScoreHistory(null, scoreEnvelope(), { ...metadata, timestamp: "not-a-timestamp" }),
    ).toThrow("invalid score history timestamp");
  });

  test("sorts commits by instant and keeps only the configured retention window", () => {
    let history = appendScoreHistory(null, scoreEnvelope(), metadata);
    for (let index = 0; index < SCORE_HISTORY_RETENTION + 2; index += 1) {
      const suffix = String(index).padStart(40, "0");
      history = appendScoreHistory(history, scoreEnvelope(90), {
        repository: metadata.repository,
        commit: suffix,
        timestamp: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    expect(history.entries).toHaveLength(SCORE_HISTORY_RETENTION);
    expect(history.entries.at(-1)?.timestamp).toBe("2027-01-01T00:16:41.000Z");
  });

  test("rejects history from another repository", () => {
    const history = appendScoreHistory(null, scoreEnvelope(), metadata);
    expect(() =>
      appendScoreHistory(history, scoreEnvelope(), {
        ...metadata,
        repository: "example/other",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toThrow("score history belongs to");
  });
});
