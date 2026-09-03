import { readFile } from "node:fs/promises";

import { REPOSITORY_SCORE_PROFILE_VERSION } from "./repository-progress-score.ts";

export const SCORE_ADOPTION_REGISTRY_SCHEMA_V1 =
  "coding-tooling/score-adoption-registry/v1" as const;

export type ScoreAdoptionTarget = "history";
export type ScoreAdoptionDashboardGroup = "foundation" | "lab" | "language" | "media";

export type ScoreAdoptionRepository = {
  repository: string;
  rolloutWave: number;
  target: ScoreAdoptionTarget;
  scoreProfileVersion: typeof REPOSITORY_SCORE_PROFILE_VERSION;
  historyBranch: string;
  dashboardGroup: ScoreAdoptionDashboardGroup;
};

export type ScoreAdoptionRegistry = {
  schemaVersion: typeof SCORE_ADOPTION_REGISTRY_SCHEMA_V1;
  reusableWorkflow: {
    repository: string;
    path: string;
    revision: string;
  };
  repositories: ScoreAdoptionRepository[];
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const workflowPathPattern = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const historyBranchPattern = /^[A-Za-z0-9._/-]+$/;
const dashboardGroups = new Set<ScoreAdoptionDashboardGroup>([
  "foundation",
  "lab",
  "language",
  "media",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], context: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function assertRepository(value: unknown, context: string): string {
  if (typeof value !== "string" || !repositoryPattern.test(value)) {
    throw new Error(`${context} must be an owner/name repository`);
  }
  return value;
}

function assertHistoryBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    !historyBranchPattern.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new Error("historyBranch must be a conservative branch name");
  }
  return value;
}

function parseRepository(value: unknown, index: number): ScoreAdoptionRepository {
  if (!isObject(value)) throw new Error(`repositories[${index}] must be an object`);
  assertKeys(
    value,
    [
      "repository",
      "rolloutWave",
      "target",
      "scoreProfileVersion",
      "historyBranch",
      "dashboardGroup",
    ],
    `repositories[${index}]`,
  );

  const repository = assertRepository(value.repository, `repositories[${index}].repository`);
  if (!Number.isInteger(value.rolloutWave) || Number(value.rolloutWave) < 1) {
    throw new Error(`repositories[${index}].rolloutWave must be a positive integer`);
  }
  if (value.target !== "history") {
    throw new Error(`repositories[${index}].target must be history`);
  }
  if (value.scoreProfileVersion !== REPOSITORY_SCORE_PROFILE_VERSION) {
    throw new Error(
      `repositories[${index}].scoreProfileVersion must be ${REPOSITORY_SCORE_PROFILE_VERSION}`,
    );
  }
  const historyBranch = assertHistoryBranch(value.historyBranch);
  if (typeof value.dashboardGroup !== "string" || !dashboardGroups.has(value.dashboardGroup as ScoreAdoptionDashboardGroup)) {
    throw new Error(`repositories[${index}].dashboardGroup is unsupported`);
  }

  return {
    repository,
    rolloutWave: Number(value.rolloutWave),
    target: "history",
    scoreProfileVersion: REPOSITORY_SCORE_PROFILE_VERSION,
    historyBranch,
    dashboardGroup: value.dashboardGroup as ScoreAdoptionDashboardGroup,
  };
}

export function parseScoreAdoptionRegistry(value: unknown): ScoreAdoptionRegistry {
  if (!isObject(value)) throw new Error("score adoption registry must be an object");
  assertKeys(value, ["schemaVersion", "reusableWorkflow", "repositories"], "registry");
  if (value.schemaVersion !== SCORE_ADOPTION_REGISTRY_SCHEMA_V1) {
    throw new Error(`schemaVersion must be ${SCORE_ADOPTION_REGISTRY_SCHEMA_V1}`);
  }

  if (!isObject(value.reusableWorkflow)) {
    throw new Error("reusableWorkflow must be an object");
  }
  assertKeys(value.reusableWorkflow, ["repository", "path", "revision"], "reusableWorkflow");
  const workflowRepository = assertRepository(
    value.reusableWorkflow.repository,
    "reusableWorkflow.repository",
  );
  if (
    typeof value.reusableWorkflow.path !== "string" ||
    !workflowPathPattern.test(value.reusableWorkflow.path)
  ) {
    throw new Error("reusableWorkflow.path must be a reusable workflow path");
  }
  if (
    typeof value.reusableWorkflow.revision !== "string" ||
    !shaPattern.test(value.reusableWorkflow.revision)
  ) {
    throw new Error("reusableWorkflow.revision must be an immutable lowercase commit SHA");
  }

  if (!Array.isArray(value.repositories) || value.repositories.length === 0) {
    throw new Error("repositories must be a non-empty array");
  }
  const repositories = value.repositories.map(parseRepository);
  const names = repositories.map((entry) => entry.repository);
  const unique = new Set(names);
  if (unique.size !== names.length) throw new Error("repository entries must be unique");
  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  if (names.some((name, index) => name !== sorted[index])) {
    throw new Error("repository entries must be sorted by repository");
  }

  return {
    schemaVersion: SCORE_ADOPTION_REGISTRY_SCHEMA_V1,
    reusableWorkflow: {
      repository: workflowRepository,
      path: value.reusableWorkflow.path,
      revision: value.reusableWorkflow.revision,
    },
    repositories,
  };
}

export async function loadScoreAdoptionRegistry(path = "score-adoption.json") {
  return parseScoreAdoptionRegistry(JSON.parse(await readFile(path, "utf8")));
}
