import { describe, expect, test } from "bun:test";

import { remoteValidationOutcome } from "../site/evidence-model.js";
import { analyzeSnapshot } from "../site/preflight.js";

function validation(workflow, declaredCommands) {
  return remoteValidationOutcome({
    workflowPaths: [".github/workflows/validate.yml"],
    workflows: [{ path: ".github/workflows/validate.yml", content: workflow }],
    externalCiPaths: [],
    workflowFetchTruncated: false,
    defaultBranch: "main",
    declaredCommands,
  });
}

function workspaceSnapshot(workflow) {
  const root = {
    name: "root",
    packageManager: "bun@1.4.0",
    workspaces: ["packages/*"],
    scripts: {},
  };
  const app = { name: "app", scripts: { lint: "oxlint ." } };
  return {
    repository: { name: "fixture", fullName: "example/fixture", defaultBranch: "main" },
    tree: [
      { path: "package.json", type: "blob", sha: "root" },
      { path: "packages/app/package.json", type: "blob", sha: "app" },
      { path: ".coding-tooling.json", type: "blob", sha: "config" },
      { path: ".github/workflows/validate.yml", type: "blob", sha: "workflow" },
      { path: "AGENTS.md", type: "blob", sha: "agents" },
      { path: "renovate.json", type: "blob", sha: "renovate" },
    ],
    files: {
      "package.json": JSON.stringify(root),
      "packages/app/package.json": JSON.stringify(app),
      ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
      ".github/workflows/validate.yml": workflow,
    },
    treeTruncated: false,
    manifestFetchTruncated: false,
    workflowFetchTruncated: false,
    unreadablePaths: [],
  };
}

const pullRequestPrefix = `on:\n  pull_request:\njobs:\n  validate:\n    steps:\n`;

describe("component-scoped remote validation", () => {
  test("a root command cannot prove a nested component command", () => {
    const result = validation(`${pullRequestPrefix}      - run: bun run lint\n`, [
      { command: "bun run lint", workingDirectory: "packages/app" },
    ]);

    expect(result.status).toBe("finding");
    expect(result.reason).toBe("automation-without-validation-evidence");
    expect(result.workflowEvidence[0].matchedCommands).toEqual([]);
  });

  test("a literal step working-directory proves the nested command", () => {
    const result = validation(
      `${pullRequestPrefix}      - name: Lint app\n        working-directory: packages/app\n        run: bun run lint\n`,
      [{ command: "bun run lint", workingDirectory: "packages/app" }],
    );

    expect(result.status).toBe("satisfied");
    expect(result.workflowEvidence[0].matchedCommandEvidence).toEqual([
      { command: "bun run lint", workingDirectory: "packages/app" },
    ]);
  });

  test("an explicit cd can prove a nested command without overclaiming the root", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: cd packages/app && bun run lint\n`,
      [{ command: "bun run lint", workingDirectory: "packages/app" }],
    );

    expect(result.status).toBe("satisfied");
  });

  test("workspace inheritance keeps validation command evidence component-scoped", () => {
    const rootOnly = analyzeSnapshot(
      workspaceSnapshot(`${pullRequestPrefix}      - run: bun run lint\n`),
    );
    const memberScoped = analyzeSnapshot(
      workspaceSnapshot(
        `${pullRequestPrefix}      - working-directory: packages/app\n        run: bun run lint\n`,
      ),
    );

    expect(rootOnly.validationEvidence.status).toBe("finding");
    expect(memberScoped.validationEvidence.status).toBe("satisfied");
  });
});
