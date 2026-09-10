import { describe, expect, test } from "bun:test";

import { remoteCommandFromSnapshot } from "../site/remote-command.js";

describe("Pages command execution evidence", () => {
  test("findings exposes the same execution-linked toolchain contradiction as analysis.json", () => {
    const snapshot = {
      repository: {
        owner: "example",
        name: "repo",
        fullName: "example/repo",
        defaultBranch: "main",
        htmlUrl: "https://github.com/example/repo",
        description: null,
        archived: false,
        fork: false,
        stars: 0,
        openIssues: 0,
      },
      tree: [
        blob("package.json"),
        blob("package-lock.json"),
        blob(".node-version"),
        blob(".coding-tooling.json"),
        blob("AGENTS.md"),
        blob("renovate.json"),
        blob("src/index.ts"),
        blob("tests/index.test.ts"),
        blob(".github/workflows/validate.yml"),
      ],
      files: {
        "package.json": JSON.stringify({
          name: "fixture",
          scripts: { test: "vitest run" },
        }),
        ".node-version": "24.20.0\n",
        ".coding-tooling.json": JSON.stringify({
          schemaVersion: 1,
          requiredCapabilities: ["test:unit"],
        }),
        ".github/workflows/validate.yml": `name: Validate\non:\n  pull_request:\njobs:\n  validate:\n    uses: owner/reusable/.github/workflows/validate.yml@v1\n    with:\n      node_version: "20"\n      install_command: npm ci\n      unit_test_command: npm run test\n`,
      },
      treeTruncated: false,
      manifestFetchTruncated: false,
      workflowFetchTruncated: false,
      unreadablePaths: [],
    };

    const result = remoteCommandFromSnapshot(snapshot, ["findings", "--json"]);

    expect(result.status).toBe("failed");
    expect(result.data.findings).toContainEqual(
      expect.objectContaining({
        id: "REMOTE-EXECUTION-TOOLCHAIN",
        severity: "high",
      }),
    );
  });
});

function blob(path) {
  return { path, sha: path, type: "blob" };
}
