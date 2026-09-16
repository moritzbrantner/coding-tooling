import { describe, expect, test } from "bun:test";

import { remoteValidationOutcome } from "../site/evidence-model.js";
import { analyzeSnapshot } from "../site/preflight.js";

function validation(workflow, declaredCommands, packageScripts = []) {
  return remoteValidationOutcome({
    workflowPaths: [".github/workflows/validate.yml"],
    workflows: [{ path: ".github/workflows/validate.yml", content: workflow }],
    externalCiPaths: [],
    workflowFetchTruncated: false,
    defaultBranch: "main",
    declaredCommands,
    packageScripts,
  });
}

function workspaceSnapshot(workflow, appScripts = { lint: "oxlint ." }) {
  const root = {
    name: "root",
    packageManager: "bun@1.4.0",
    workspaces: ["packages/*"],
    scripts: {},
  };
  const app = { name: "app", scripts: appScripts };
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

  test("a bounded package-script wrapper can prove a declared validation command", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify:web\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: {
            "verify:web": "npm run verify:tests",
            "verify:tests": "npm test",
            test: "npm run test:unit",
            "test:unit": "vitest run",
          },
        },
      ],
    );

    expect(result.status).toBe("satisfied");
    expect(result.workflowEvidence[0].matchedCommands).toEqual(["npm run test:unit"]);
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([
      {
        command: "npm run verify:web",
        script: "verify:web",
        workingDirectory: ".",
        matchedCommands: ["npm run test:unit"],
      },
    ]);
  });

  test("workspace-scoped wrapper invocation cannot satisfy root package evidence", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify --workspace child\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "npm run test:unit", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("backgrounded package-script validation remains non-validating", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "npm run test:unit & true", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("early-exit package-script segments remain non-validating", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "exit 0 && npm run test:unit", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("unbounded shell segments keep wrapper evidence unavailable", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "echo setup && npm run test:unit", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("cyclic package-script wrappers remain non-validating", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "npm run inner", inner: "npm run verify" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("deployment-only wrappers do not satisfy validation evidence", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run deploy\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { deploy: "npm run build", build: "vite build" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedCommands).toEqual([]);
  });

  test("Pages preflight resolves a nested Bun validation wrapper from fetched package scripts", () => {
    const analysis = analyzeSnapshot(
      workspaceSnapshot(
        `${pullRequestPrefix}      - name: Verify app\n        working-directory: packages/app\n        run: bun run verify:web\n`,
        {
          "test:unit": "bun test",
          build: "vite build",
          "verify:web": "bun run verify:checks",
          "verify:checks": "bun run test:unit && bun run build",
        },
      ),
    );

    expect(analysis.validationEvidence.status).toBe("satisfied");
    expect(analysis.validationEvidence.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([
      {
        command: "bun run verify:web",
        script: "verify:web",
        workingDirectory: "packages/app",
        matchedCommands: ["bun run build", "bun run test:unit"],
      },
    ]);
  });

  test("workspace inheritance keeps validation command evidence component-scoped", () => {
    const rootOnly = analyzeSnapshot(
      workspaceSnapshot(`${pullRequestPrefix}      - run: bun run lint\n`),
    );
    const memberScoped = analyzeSnapshot(
      workspaceSnapshot(
        `${pullRequestPrefix}      - name: Lint app\n        working-directory: packages/app\n        run: bun run lint\n`,
      ),
    );

    expect(rootOnly.validationEvidence.status).toBe("finding");
    expect(memberScoped.validationEvidence.status).toBe("satisfied");
  });
});
