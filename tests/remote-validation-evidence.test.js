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

  test("mentions of a validation command do not prove execution", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/mentions.yml"],
      workflows: [
        {
          path: ".github/workflows/mentions.yml",
          content: `on:
  pull_request:
jobs:
  verify:
    steps:
      - run: echo "bun run typecheck"
      # run: bun run typecheck
`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run typecheck"],
    });
    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedCommands).toEqual([]);
  });

  test("non-run coding-tooling Action operations do not prove validation", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/score.yml"],
      workflows: [
        {
          path: ".github/workflows/score.yml",
          content: `on:
  push:
    branches: [main]
jobs:
  score:
    steps:
      - uses: ./
        with:
          operation: score
`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: [],
      localActionIsCodingTooling: true,
    });
    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].codingToolingAction).toBe(false);
  });

  test("the default coding-tooling Action operation proves validation", () => {
    const result = remoteValidationOutcome({
      workflowPaths: [".github/workflows/validate.yml"],
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `on:
  pull_request:
jobs:
  validate:
    steps:
      - uses: ./
        with:
          tier: self
`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: [],
      localActionIsCodingTooling: true,
    });
    expect(result.status).toBe("satisfied");
    expect(result.workflowEvidence[0].codingToolingAction).toBe(true);
  });

  test("inline push branch filters must include the default branch", () => {
    const offDefault = remoteValidationOutcome({
      workflowPaths: [".github/workflows/validate.yml"],
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `on:\n  push: { branches: [develop] }\njobs:\n  verify:\n    steps:\n      - run: bun run typecheck\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run typecheck"],
    });
    expect(offDefault.status).toBe("finding");
    expect(offDefault.workflowEvidence[0].relevantTrigger).toBe(false);

    const onDefault = remoteValidationOutcome({
      workflowPaths: [".github/workflows/validate.yml"],
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `on:\n  push: { branches: [main] }\njobs:\n  verify:\n    steps:\n      - run: bun run typecheck\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["bun run typecheck"],
    });
    expect(onDefault.status).toBe("satisfied");
    expect(onDefault.workflowEvidence[0].relevantTrigger).toBe(true);
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

  test("proves validation through an exact-ref reusable workflow command", () => {
    const ref = "45042e56be120b438096e774027637cac0280075";
    const callerPath = ".github/workflows/validate.yml";
    const result = remoteValidationOutcome({
      workflowPaths: [callerPath],
      workflows: [
        {
          path: callerPath,
          content: `on:
  pull_request:
jobs:
  validate:
    uses: owner/reusable/.github/workflows/validate.yml@${ref}
    with:
      test_command: cargo test --locked --workspace
      working_directory: crates/world
`,
        },
      ],
      reusableWorkflows: [
        {
          callerPath,
          job: "validate",
          inputs: {
            test_command: "cargo test --locked --workspace",
            working_directory: "crates/world",
          },
          target: {
            status: "pinned",
            reference: `owner/reusable/.github/workflows/validate.yml@${ref}`,
            repository: "owner/reusable",
            path: ".github/workflows/validate.yml",
            ref,
          },
          status: "resolved",
          repository: "owner/reusable",
          path: ".github/workflows/validate.yml",
          ref,
          content: `on:
  workflow_call:
    inputs:
      test_command:
        type: string
      working_directory:
        type: string
        default: .
jobs:
  validate:
    steps:
      - run: \${{ inputs.test_command }}
    defaults:
      run:
        working-directory: \${{ inputs.working_directory }}
`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: [
        { command: "cargo test --locked --workspace", workingDirectory: "crates/world" },
      ],
    });

    expect(result.status).toBe("satisfied");
    expect(result.workflowEvidence[0].reusableWorkflowEvidence[0]).toEqual(
      expect.objectContaining({
        status: "satisfied",
        matchedCommands: ["cargo test --locked --workspace"],
      }),
    );
  });

  test("keeps mutable reusable workflow references incomplete", () => {
    const callerPath = ".github/workflows/validate.yml";
    const result = remoteValidationOutcome({
      workflowPaths: [callerPath],
      workflows: [
        {
          path: callerPath,
          content: `on:
  pull_request:
jobs:
  validate:
    uses: owner/reusable/.github/workflows/validate.yml@main
`,
        },
      ],
      reusableWorkflows: [
        {
          callerPath,
          job: "validate",
          inputs: {},
          target: {
            status: "unsupported",
            reference: "owner/reusable/.github/workflows/validate.yml@main",
            repository: "owner/reusable",
            path: ".github/workflows/validate.yml",
            ref: "main",
          },
          status: "unsupported",
          reason: "reusable-workflow-ref-not-immutable",
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["cargo test --locked"],
    });

    expect(result.status).toBe("incomplete");
    expect(result.reason).toBe("reusable-workflow-evidence-incomplete");
  });

  test("keeps call-limit and nested reusable workflow evidence incomplete", () => {
    const ref = "a".repeat(40);
    const callerPath = ".github/workflows/validate.yml";
    const input = {
      workflowPaths: [callerPath],
      workflows: [
        {
          path: callerPath,
          content: `on:\n  pull_request:\njobs:\n  validate:\n    uses: owner/reusable/.github/workflows/validate.yml@${ref}\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["cargo test --locked"],
    };

    expect(
      remoteValidationOutcome({ ...input, reusableWorkflowEvidenceIncomplete: true }).status,
    ).toBe("incomplete");

    const nested = remoteValidationOutcome({
      ...input,
      reusableWorkflows: [
        {
          callerPath,
          job: "validate",
          inputs: {},
          target: {
            status: "pinned",
            reference: `owner/reusable/.github/workflows/validate.yml@${ref}`,
            repository: "owner/reusable",
            path: ".github/workflows/validate.yml",
            ref,
          },
          status: "resolved",
          repository: "owner/reusable",
          path: ".github/workflows/validate.yml",
          ref,
          content: `on:
  workflow_call:
jobs:
  nested:
    uses: owner/other/.github/workflows/validate.yml@${"b".repeat(40)}
`,
        },
      ],
    });
    expect(nested.status).toBe("incomplete");
    expect(nested.workflowEvidence[0].reusableWorkflowEvidence[0].reason).toBe(
      "nested-reusable-workflow-unresolved",
    );
  });

  test("does not treat an echoed reusable-workflow command as validation", () => {
    const ref = "a".repeat(40);
    const callerPath = ".github/workflows/validate.yml";
    const result = remoteValidationOutcome({
      workflowPaths: [callerPath],
      workflows: [
        {
          path: callerPath,
          content: `on:\n  pull_request:\njobs:\n  validate:\n    uses: owner/reusable/.github/workflows/validate.yml@${ref}\n`,
        },
      ],
      reusableWorkflows: [
        {
          callerPath,
          job: "validate",
          inputs: {},
          target: {
            status: "pinned",
            reference: `owner/reusable/.github/workflows/validate.yml@${ref}`,
            repository: "owner/reusable",
            path: ".github/workflows/validate.yml",
            ref,
          },
          status: "resolved",
          repository: "owner/reusable",
          path: ".github/workflows/validate.yml",
          ref,
          content: `on:\n  workflow_call:\njobs:\n  validate:\n    steps:\n      - run: echo "cargo test --locked"\n`,
        },
      ],
      externalCiPaths: [],
      workflowFetchTruncated: false,
      defaultBranch: "main",
      declaredCommands: ["cargo test --locked"],
    });

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].reusableWorkflowEvidence[0].matchedCommands).toEqual([]);
  });
});
