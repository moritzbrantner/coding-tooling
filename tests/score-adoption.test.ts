import { describe, expect, test } from "bun:test";

import { REPOSITORY_SCORE_PROFILE_VERSION } from "../src/repository-progress-score.ts";
import {
  loadScoreAdoptionRegistry,
  parseScoreAdoptionRegistry,
  SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
} from "../src/score-adoption.ts";

const reusableWorkflow = {
  repository: "moritzbrantner/reusable-workflows",
  path: ".github/workflows/coding-tooling-score-history.yml",
  revision: "main",
};

function entry(repository: string) {
  return {
    repository,
    rolloutWave: 1,
    target: "history",
    scoreProfileVersion: REPOSITORY_SCORE_PROFILE_VERSION,
    historyBranch: "score-history",
    dashboardGroup: "foundation",
  };
}

describe("score adoption registry", () => {
  test("loads the checked-in first calibration wave", async () => {
    const registry = await loadScoreAdoptionRegistry();

    expect(registry.schemaVersion).toBe(SCORE_ADOPTION_REGISTRY_SCHEMA_V1);
    expect(registry.reusableWorkflow).toEqual(reusableWorkflow);
    expect(registry.repositories.map(({ repository }) => repository)).toEqual([
      "moritzbrantner/audio-analysis",
      "moritzbrantner/collision-lab",
      "moritzbrantner/moenarch-foundation",
      "moritzbrantner/nlp-stack",
      "moritzbrantner/rust-kernels",
    ]);
    expect(registry.repositories.every(({ rolloutWave }) => rolloutWave === 1)).toBe(true);
    expect(registry.repositories.every(({ target }) => target === "history")).toBe(true);
  });

  test("rejects duplicate or unsorted repository inventory", () => {
    expect(() =>
      parseScoreAdoptionRegistry({
        schemaVersion: SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
        reusableWorkflow,
        repositories: [
          entry("moritzbrantner/rust-kernels"),
          entry("moritzbrantner/audio-analysis"),
        ],
      }),
    ).toThrow("sorted");

    expect(() =>
      parseScoreAdoptionRegistry({
        schemaVersion: SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
        reusableWorkflow,
        repositories: [entry("moritzbrantner/rust-kernels"), entry("moritzbrantner/rust-kernels")],
      }),
    ).toThrow("unique");
  });

  test("accepts the current workflow branch and requires a current score-profile identity", () => {
    expect(() =>
      parseScoreAdoptionRegistry({
        schemaVersion: SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
        reusableWorkflow: { ...reusableWorkflow, revision: "not a ref" },
        repositories: [entry("moritzbrantner/rust-kernels")],
      }),
    ).toThrow("main or a lowercase commit SHA");

    expect(() =>
      parseScoreAdoptionRegistry({
        schemaVersion: SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
        reusableWorkflow,
        repositories: [
          {
            ...entry("moritzbrantner/rust-kernels"),
            scoreProfileVersion: "coding-tooling/repository-score-profile/v0",
          },
        ],
      }),
    ).toThrow(REPOSITORY_SCORE_PROFILE_VERSION);
  });

  test("keeps runtime status out of the desired-state registry", () => {
    expect(() =>
      parseScoreAdoptionRegistry({
        schemaVersion: SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
        reusableWorkflow,
        repositories: [
          {
            ...entry("moritzbrantner/rust-kernels"),
            lastSuccessfulSnapshot: "deadbeef",
          },
        ],
      }),
    ).toThrow("must contain exactly");
  });
});
