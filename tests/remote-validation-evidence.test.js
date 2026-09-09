import { describe, expect, test } from "bun:test";

import { remoteValidationOutcome } from "../site/evidence-model.js";

describe("remote validation evidence", () => {
  test("proves validation from a relevant trigger plus a declared command", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/anything.yml"],
      workflows: [
        {
          path: ".github/workflows/anything.yml",
          content: `name: Release\non:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - run: bun run typecheck\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run typecheck"],
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "satisfied",
        validatingWorkflowPaths: [".github/workflows/anything.yml"],
      }),
    );
  });

  test("workflow names alone do not prove validation", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/validate.yml"],
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `name: Validate\non:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - run: echo ok\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run typecheck"],
    });
    expect(result.status).toBe("finding");
    expect(result.reason).toBe("automation-without-validation-evidence");
  });

  test("deployment-only workflows do not prove validation", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/pages.yml"],
      workflows: [
        {
          path: ".github/workflows/pages.yml",
          content: `on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - uses: actions/deploy-pages@0123456789012345678901234567890123456789\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run test"],
    });
    expect(result.status).toBe("finding");
  });

  test("external CI remains explicit and unsupported", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [],
      workflows: [],
      externalCiPaths: [".gitlab-ci.yml"],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: [],
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "unsupported",
        provider: "external",
        reason: "external-ci-validation-not-evaluated",
      }),
    );
  });

  test("mixed external and unproven GitHub automation stays unsupported", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/release.yml"],
      workflows: [
        {
          path: ".github/workflows/release.yml",
          content: `on:\n  push:\n    branches: [main]\njobs:\n  release:\n    steps:\n      - run: echo release\n`,
        },
      ],
      externalCiPaths: [".circleci/config.yml"],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run test"],
    });
    expect(result).toEqual(expect.objectContaining({ status: "unsupported", provider: "mixed" }));
  });

  test("bounded workflow content is incomplete rather than negative evidence", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/a.yml", ".github/workflows/b.yml"],
      workflows: [
        {
          path: ".github/workflows/a.yml",
          content: `on:\n  push:\n    branches: [main]\njobs:\n  release:\n    steps:\n      - run: echo release\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: true,
      defaultBranch: "main",
      declaredCommands: ["bun run test"],
    });
    expect(result.status).toBe("incomplete");
  });
});
