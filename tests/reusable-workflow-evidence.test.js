import { describe, expect, test } from "bun:test";

import {
  discoverReusableWorkflowCalls,
  materializeReusableWorkflow,
  parseReusableWorkflowReference,
} from "../site/reusable-workflow.js";

const pinnedRef = "45042e56be120b438096e774027637cac0280075";

describe("reusable workflow evidence", () => {
  test("discovers job-level reusable workflow calls and preserves input expressions", () => {
    const calls = discoverReusableWorkflowCalls([
      {
        path: ".github/workflows/validate.yml",
        content: `on:
  pull_request:
jobs:
  validate:
    uses: moritzbrantner/reusable-workflows/.github/workflows/validate-repo.yml@${pinnedRef}
    with:
      test_command: cargo test --locked --workspace
      dynamic_command: \${{ github.event.inputs.command }}
  ordinary:
    steps:
      - uses: actions/checkout@${"1".repeat(40)}
`,
      },
    ]);

    expect(calls).toEqual([
      {
        callerPath: ".github/workflows/validate.yml",
        job: "validate",
        inputs: {
          test_command: "cargo test --locked --workspace",
          dynamic_command: "${{ github.event.inputs.command }}",
        },
        target: {
          status: "pinned",
          reference: `moritzbrantner/reusable-workflows/.github/workflows/validate-repo.yml@${pinnedRef}`,
          repository: "moritzbrantner/reusable-workflows",
          path: ".github/workflows/validate-repo.yml",
          ref: pinnedRef,
        },
      },
    ]);
  });

  test("only treats exact commit references as immutable", () => {
    expect(
      parseReusableWorkflowReference(`owner/repo/.github/workflows/validate.yml@${"a".repeat(40)}`)
        ?.status,
    ).toBe("pinned");
    expect(
      parseReusableWorkflowReference("owner/repo/.github/workflows/validate.yml@main"),
    ).toEqual(
      expect.objectContaining({
        status: "unsupported",
        reason: "reusable-workflow-ref-not-immutable",
      }),
    );
  });

  test("keeps caller inputs inside the with block and ignores comments", () => {
    const [call] = discoverReusableWorkflowCalls([
      {
        path: ".github/workflows/validate.yml",
        content: `on: pull_request
jobs:
# A comment does not end the jobs mapping.
  validate:
    # Nor does it determine the property indentation.
    uses: owner/repo/.github/workflows/validate.yml@${pinnedRef}
    with:
      test_command: echo skipped
    secrets:
      test_command: cargo test --locked
`,
      },
    ]);

    expect(call?.inputs).toEqual({ test_command: "echo skipped" });
  });

  test("does not read sibling mappings as children of an empty with block", () => {
    const [call] = discoverReusableWorkflowCalls([
      {
        path: ".github/workflows/validate.yml",
        content: `jobs:
  validate:
    uses: owner/repo/.github/workflows/validate.yml@${pinnedRef}
    with: {}
    secrets:
      test_command: cargo test --locked
`,
      },
    ]);
    expect(call?.inputs).toEqual({});
  });

  test("treats inherited object names as unresolved inputs", () => {
    const result = materializeReusableWorkflow(
      "on: workflow_call\njobs:\n  validate:\n    steps:\n      - run: ${{ inputs.toString }}\n",
      {},
    );
    expect(result.unresolvedInputs).toEqual(["toString"]);
    expect(result.content).toContain("${{ inputs.toString }}");
  });

  test("materializes explicitly declared inputs with object-prototype names", () => {
    const [call] = discoverReusableWorkflowCalls([
      {
        path: ".github/workflows/validate.yml",
        content: `jobs:
  validate:
    uses: owner/repo/.github/workflows/validate.yml@${pinnedRef}
    with:
      __proto__: cargo test --locked
`,
      },
    ]);
    const result = materializeReusableWorkflow(
      "on: workflow_call\njobs:\n  validate:\n    steps:\n      - run: ${{ inputs.__proto__ }}\n",
      call.inputs,
    );
    expect(result.unresolvedInputs).toEqual([]);
    expect(result.content).toContain("run: cargo test --locked");
  });

  test("materializes literal caller inputs over reusable workflow defaults", () => {
    const result = materializeReusableWorkflow(
      `on:
# Comments do not terminate the trigger or input mappings.
  workflow_call:
    inputs:
      test_command:
        type: string
        default: cargo test --locked
      working_directory:
        type: string
        default: .
jobs:
  validate:
    defaults:
      run:
        working-directory: \${{ inputs.working_directory }}
    steps:
      - run: \${{ inputs.test_command }}
      - run: \${{ inputs.missing_command }}
`,
      { test_command: "cargo test --locked --workspace" },
    );

    expect(result.workflowCall).toBe(true);
    expect(result.content).toContain("working-directory: .");
    expect(result.content).toContain("run: cargo test --locked --workspace");
    expect(result.unresolvedInputs).toEqual(["missing_command"]);
  });
});
