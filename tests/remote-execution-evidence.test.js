import { describe, expect, test } from "bun:test";

import { remoteExecutionEvidence } from "../site/execution-evidence.js";

describe("remote execution evidence", () => {
  test("finds explicit hosted Node drift from the repository exact pin", () => {
    const evidence = remoteExecutionEvidence({
      expectedToolchains: { node: "24.20.0" },
      workflows: [
        {
          path: ".github/workflows/performance.yml",
          content: `jobs:\n  performance:\n    uses: owner/workflows/.github/workflows/performance.yml@v1\n    with:\n      node_version: "20"\n`,
        },
      ],
    });

    expect(evidence.toolchains).toEqual(
      expect.objectContaining({
        status: "finding",
        mismatches: [
          expect.objectContaining({
            workflow: ".github/workflows/performance.yml",
            runtime: "node",
            expected: "24.20.0",
            observed: "20",
          }),
        ],
      }),
    );
  });

  test("accepts matching exact workflow toolchains and ignores expressions", () => {
    const evidence = remoteExecutionEvidence({
      expectedToolchains: { node: "24.20.0", rust: "1.98.1" },
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `jobs:\n  js:\n    uses: owner/workflows/.github/workflows/validate.yml@v1\n    with:\n      node_version: "24.20.0"\n  rust:\n    steps:\n      - uses: dtolnay/rust-toolchain@1.98.1\n      - uses: actions/setup-node@v6\n        with:\n          node-version: \${{ matrix.node }}\n`,
        },
      ],
    });

    expect(evidence.toolchains.status).toBe("satisfied");
    expect(evidence.toolchains.mismatches).toEqual([]);
  });

  test("finds committed Cargo resolution consumed without --locked", () => {
    const evidence = remoteExecutionEvidence({
      lockfiles: ["Cargo.lock"],
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `jobs:\n  rust:\n    steps:\n      - run: cargo clippy --workspace --all-targets --all-features\n      - run: cargo test --workspace\n`,
        },
      ],
    });

    expect(evidence.dependencyResolution.status).toBe("finding");
    expect(evidence.dependencyResolution.violations.map((item) => item.command)).toEqual([
      "cargo clippy --workspace --all-targets --all-features",
      "cargo test --workspace",
    ]);
  });

  test("recognizes deterministic lock consumption for supported package managers", () => {
    const evidence = remoteExecutionEvidence({
      lockfiles: ["package-lock.json"],
      workflows: [
        {
          path: ".github/workflows/validate.yml",
          content: `jobs:\n  validate:\n    uses: owner/workflows/.github/workflows/validate.yml@v1\n    with:\n      install_command: npm ci\n`,
        },
      ],
    });

    expect(evidence.dependencyResolution.status).toBe("satisfied");
    expect(evidence.dependencyResolution.violations).toEqual([]);
  });

  test("does not use an explicitly fail-open command as validation evidence", () => {
    const path = ".github/workflows/validate.yml";
    const evidence = remoteExecutionEvidence({
      validationEvidence: validation(path, ["npm test"]),
      workflows: [
        {
          path,
          content: `on: [pull_request]\njobs:\n  validate:\n    steps:\n      - name: Tests\n        run: npm test || true\n`,
        },
      ],
    });

    expect(evidence.failClosed).toEqual(
      expect.objectContaining({
        status: "finding",
        reason: "all-proven-validation-is-fail-open",
      }),
    );
  });

  test("does not use continue-on-error validation as fail-closed evidence", () => {
    const path = ".github/workflows/validate.yml";
    const evidence = remoteExecutionEvidence({
      validationEvidence: validation(path, ["npm test"]),
      workflows: [
        {
          path,
          content: `on: [pull_request]\njobs:\n  validate:\n    steps:\n      - name: Tests\n        run: npm test\n        continue-on-error: true\n`,
        },
      ],
    });

    expect(evidence.failClosed.status).toBe("finding");
  });

  test("accepts ordinary validation failure propagation", () => {
    const path = ".github/workflows/validate.yml";
    const evidence = remoteExecutionEvidence({
      validationEvidence: validation(path, ["npm test"]),
      workflows: [
        {
          path,
          content: `on: [pull_request]\njobs:\n  validate:\n    steps:\n      - name: Tests\n        run: npm test\n`,
        },
      ],
    });

    expect(evidence.failClosed.status).toBe("satisfied");
  });
});

function validation(path, matchedCommands) {
  return {
    status: "satisfied",
    validatingWorkflowPaths: [path],
    workflowEvidence: [
      {
        path,
        status: "satisfied",
        relevantTrigger: true,
        validationInvocation: true,
        matchedCommands,
        codingToolingAction: false,
      },
    ],
  };
}
