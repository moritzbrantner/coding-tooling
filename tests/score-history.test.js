import { describe, expect, test } from "bun:test";

import {
  appendScoreHistory,
  SCORE_HISTORY_RETENTION,
  SCORE_HISTORY_SCHEMA_V1,
} from "../scripts/append-score-history.mjs";

const SCORE_PROFILE = "coding-tooling/repository-score-profile/v1";
const fingerprint = `sha256:${"1".repeat(64)}`;

function scoreEnvelope(
  score = 88,
  options = {
    profileVersion: SCORE_PROFILE,
    fingerprint,
    auditScore: 100,
    verificationScore: 75,
  },
) {
  const failedSubjects = options.auditScore === 100 ? 0 : 1;
  const activeFindings = failedSubjects;
  return {
    schemaVersion: 1,
    operation: "score",
    profileVersion: options.profileVersion,
    status: "passed",
    durationMs: 10,
    data: {
      root: "/repo",
      score: {
        schemaVersion: "coding-tooling/repository-score/v1",
        profileVersion: options.profileVersion,
        definition: {
          schemaVersion: "coding-tooling/repository-score-definition/v1",
          profileVersion: options.profileVersion,
          fingerprint: options.fingerprint,
        },
        score,
        rating: score >= 90 ? "good" : "needs-improvement",
        completeness: "complete",
        structuralScore: options.auditScore,
        verificationScore: options.verificationScore,
        categories: [
          { id: "testing", score: options.auditScore, auditCount: 1 },
          { id: "verification", score: options.verificationScore, auditCount: 1 },
        ],
        audits: [
          {
            id: "typescript-source-test",
            version: 2,
            description: "TypeScript source has test reachability",
            category: "testing",
            severity: "warning",
            coverageStatus: "applied",
            coverageSubjects: 2,
            scoreModel: "subject-v1",
            subjects: 2,
            failedSubjects,
            activeFindings,
            suppressedFindings: 0,
            verifiedFindings: 0,
            score: options.auditScore,
          },
        ],
        verification: {
          source: "coding-tooling/run/v1",
          reportPath: ".artifacts/coding-tooling/run.json",
          status: options.verificationScore === 100 ? "passed" : "failed",
          score: options.verificationScore,
          plannedChecks: 4,
          passedChecks: options.verificationScore === 100 ? 4 : 3,
          failedChecks: options.verificationScore === 100 ? 0 : 1,
          errorChecks: 0,
          blockedChecks: 0,
          missingRequiredCapabilities: 0,
        },
        coverage: {},
        findings: { active: activeFindings, suppressed: 0, verified: 0 },
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
  producerCommit: "cccccccccccccccccccccccccccccccccccccccc",
  workflowRunId: "33799999999",
  workflowRunAttempt: 2,
  validationTier: "self",
};

const provenance = {
  producerCommit: metadata.producerCommit,
  workflowRunId: metadata.workflowRunId,
  workflowRunAttempt: metadata.workflowRunAttempt,
  validationTier: metadata.validationTier,
};

const nextMetadata = {
  ...metadata,
  commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  timestamp: "2026-09-03T19:00:00Z",
};

describe("repository score history", () => {
  test("persists profile, definition, provenance, and audit-level evidence", () => {
    const history = appendScoreHistory(null, scoreEnvelope(), metadata);

    expect(history.schemaVersion).toBe(SCORE_HISTORY_SCHEMA_V1);
    expect(history.retention).toBe(SCORE_HISTORY_RETENTION);
    expect(history.definitions[fingerprint]).toEqual(
      expect.objectContaining({
        schemaVersion: "coding-tooling/repository-score-definition/v1",
        profileVersion: SCORE_PROFILE,
        fingerprint,
      }),
    );
    expect(history.entries).toEqual([
      expect.objectContaining({
        commit: metadata.commit,
        timestamp: "2026-09-03T18:00:00.000Z",
        scoreProfileVersion: SCORE_PROFILE,
        definitionFingerprint: fingerprint,
        provenance,
        score: 88,
        structuralScore: 100,
        verificationScore: 75,
        categories: { testing: 100, verification: 75 },
        audits: [
          expect.objectContaining({
            id: "typescript-source-test",
            score: 100,
            subjects: 2,
            failedSubjects: 0,
          }),
        ],
        verification: expect.objectContaining({ status: "failed", passedChecks: 3 }),
        findings: { active: 0, suppressed: 0, verified: 0 },
        change: expect.objectContaining({ status: "first-snapshot", comparable: false }),
      }),
    ]);
  });

  test("requires provenance for every new snapshot", () => {
    expect(() =>
      appendScoreHistory(null, scoreEnvelope(), { ...metadata, producerCommit: undefined }),
    ).toThrow("provenance");
  });

  test("rejects an invalid workflow run attempt", () => {
    expect(() =>
      appendScoreHistory(null, scoreEnvelope(), { ...metadata, workflowRunAttempt: "zero" }),
    ).toThrow("positive integer");
  });

  test("attributes comparable score movement to verification and individual audits", () => {
    const first = appendScoreHistory(null, scoreEnvelope(), metadata);
    const history = appendScoreHistory(
      first,
      scoreEnvelope(75, {
        profileVersion: SCORE_PROFILE,
        fingerprint,
        auditScore: 50,
        verificationScore: 100,
      }),
      nextMetadata,
    );
    const change = history.entries.at(-1).change;

    expect(change).toEqual(
      expect.objectContaining({
        status: "comparable",
        comparable: true,
        priorCommit: metadata.commit,
        scoreDelta: -13,
        structuralScoreDelta: -50,
      }),
    );
    expect(change.verification).toEqual(expect.objectContaining({ scoreDelta: 25 }));
    expect(change.categoryDeltas).toContainEqual({
      id: "testing",
      before: 100,
      after: 50,
      delta: -50,
    });
    expect(change.auditDeltas).toContainEqual(
      expect.objectContaining({
        id: "typescript-source-test",
        scoreDelta: -50,
        failedSubjectsDelta: 1,
        activeFindingsDelta: 1,
      }),
    );
  });

  test("retains a score-production error as an unscored comparison boundary", () => {
    const first = appendScoreHistory(null, scoreEnvelope(), metadata);
    const history = appendScoreHistory(first, errorEnvelope(), nextMetadata);
    const tombstone = history.entries.at(-1);

    expect(tombstone).toEqual(
      expect.objectContaining({
        commit: nextMetadata.commit,
        scoreProfileVersion: SCORE_PROFILE,
        definitionFingerprint: null,
        provenance,
        score: null,
        rating: "unavailable",
        completeness: "unavailable",
        structuralScore: null,
        verificationScore: null,
        audits: [],
        verification: expect.objectContaining({ status: "error", score: null }),
        diagnostics: [expect.objectContaining({ code: "repository-verification-score-failed" })],
        change: expect.objectContaining({ status: "definition-unknown", comparable: false }),
      }),
    );
  });

  test("a score after an error tombstone remains non-comparable across missing evidence", () => {
    let history = appendScoreHistory(null, scoreEnvelope(), metadata);
    history = appendScoreHistory(history, errorEnvelope(), nextMetadata);
    history = appendScoreHistory(history, scoreEnvelope(90), {
      ...metadata,
      commit: "dddddddddddddddddddddddddddddddddddddddd",
      timestamp: "2026-09-03T20:00:00Z",
    });

    expect(history.entries.at(-1).change).toEqual(
      expect.objectContaining({ status: "definition-unknown", comparable: false }),
    );
  });

  test("replaces an error tombstone and its provenance when the same commit later scores", () => {
    const failed = appendScoreHistory(null, errorEnvelope(), metadata);
    const recovered = appendScoreHistory(failed, scoreEnvelope(100), {
      ...metadata,
      workflowRunAttempt: metadata.workflowRunAttempt + 1,
    });

    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0].score).toBe(100);
    expect(recovered.entries[0].definitionFingerprint).toBe(fingerprint);
    expect(recovered.entries[0].provenance.workflowRunAttempt).toBe(3);
    expect(recovered.entries[0].verification.status).toBe("failed");
    expect(recovered.entries[0].diagnostics).toBeUndefined();
  });

  test("rejects an unscored non-error envelope", () => {
    const envelope = { ...errorEnvelope(), status: "unavailable" };
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("not an error tombstone");
  });

  test("refuses numeric attribution across scoring-profile changes", () => {
    const first = appendScoreHistory(null, scoreEnvelope(), metadata);
    const nextProfile = "coding-tooling/repository-score-profile/v2";
    const nextFingerprint = `sha256:${"2".repeat(64)}`;
    const history = appendScoreHistory(
      first,
      scoreEnvelope(80, {
        profileVersion: nextProfile,
        fingerprint: nextFingerprint,
        auditScore: 80,
        verificationScore: 80,
      }),
      nextMetadata,
    );

    expect(history.entries.at(-1).change).toEqual(
      expect.objectContaining({
        status: "profile-changed",
        comparable: false,
        scoreDelta: -8,
        auditDeltas: [],
      }),
    );
  });

  test("refuses numeric attribution across exact definition changes within one profile", () => {
    const first = appendScoreHistory(null, scoreEnvelope(), metadata);
    const nextFingerprint = `sha256:${"2".repeat(64)}`;
    const history = appendScoreHistory(
      first,
      scoreEnvelope(80, {
        profileVersion: SCORE_PROFILE,
        fingerprint: nextFingerprint,
        auditScore: 80,
        verificationScore: 80,
      }),
      nextMetadata,
    );

    expect(history.entries.at(-1).change).toEqual(
      expect.objectContaining({
        status: "definition-changed",
        comparable: false,
        scoreDelta: -8,
        auditDeltas: [],
      }),
    );
  });

  test("replaces a rerun and recomputes downstream attribution", () => {
    let history = appendScoreHistory(null, scoreEnvelope(88), metadata);
    history = appendScoreHistory(history, scoreEnvelope(90), nextMetadata);
    history = appendScoreHistory(history, scoreEnvelope(100), {
      ...metadata,
      workflowRunAttempt: metadata.workflowRunAttempt + 1,
    });

    expect(history.entries).toHaveLength(2);
    expect(history.entries[0].score).toBe(100);
    expect(history.entries[0].provenance.workflowRunAttempt).toBe(3);
    expect(history.entries[1].change.scoreDelta).toBe(-10);
  });

  test("canonicalizes offsets and attributes in chronological order", () => {
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
    expect(second.entries[1].change.priorCommit).toBe(second.entries[0].commit);
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
        ...metadata,
        commit: suffix,
        timestamp: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    expect(history.entries).toHaveLength(SCORE_HISTORY_RETENTION);
    expect(history.entries.at(-1).timestamp).toBe("2027-01-01T00:16:41.000Z");
  });

  test("rejects score reports without a scoring profile", () => {
    const envelope = scoreEnvelope();
    delete envelope.data.score.profileVersion;
    delete envelope.profileVersion;
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("scoring profile");
  });

  test("rejects mismatched score document and envelope profiles", () => {
    const envelope = scoreEnvelope();
    envelope.profileVersion = "coding-tooling/repository-score-profile/v2";
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("score envelope profile");
  });

  test("rejects score reports without a definition fingerprint", () => {
    const envelope = scoreEnvelope();
    delete envelope.data.score.definition;
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("definition fingerprint");
  });

  test("rejects a definition that claims another scoring profile", () => {
    const envelope = scoreEnvelope();
    envelope.data.score.definition.profileVersion = "coding-tooling/repository-score-profile/v2";
    expect(() => appendScoreHistory(null, envelope, metadata)).toThrow("does not match");
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
