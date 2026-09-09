import { describe, expect, test } from "bun:test";

import { analyzeSnapshot } from "../site/preflight.js";
import { remoteCommandFromSnapshot } from "../site/remote-command.js";

describe("remote structural test evidence", () => {
  test("does not claim Rust tests are missing when inline tests are unobservable", () => {
    const snapshot = repository({
      tree: [
        blob("Cargo.toml"),
        blob("src/lib.rs"),
        blob(".coding-tooling.json"),
        blob("rust-toolchain.toml"),
        blob("AGENTS.md"),
        blob("renovate.json"),
        blob(".github/workflows/validate.yml"),
      ],
      files: {
        ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.91.0"\n',
        ".github/workflows/validate.yml": rustValidationWorkflow(),
      },
    });
    const analysis = analyzeSnapshot(snapshot);

    expect(analysis.findings.map((finding) => finding.id)).not.toContain("REMOTE-TEST-001");
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({
        id: "REMOTE-TEST-002",
        severity: "low",
      }),
    );
    expect(analysis.summary.highPriorityFindingCount).toBe(0);

    const remoteFindings = remoteCommandFromSnapshot(snapshot, "findings --json");
    expect(remoteFindings.data.counts).toEqual({ total: 1, high: 0, medium: 0, low: 1 });
  });

  test("keeps the high structural signal for ecosystems with separate test paths", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json"),
          blob("src/index.ts"),
          blob(".node-version"),
          blob(".coding-tooling.json"),
          blob("AGENTS.md"),
          blob("renovate.json"),
          blob(".github/workflows/validate.yml"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".node-version": "24.20.0\n",
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      }),
    );

    expect(analysis.findings).toContainEqual(
      expect.objectContaining({
        id: "REMOTE-TEST-001",
        severity: "high",
      }),
    );
  });
});

function repository(overrides) {
  return {
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
    tree: [],
    files: {},
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
    ...overrides,
  };
}

function rustValidationWorkflow() {
  return `on:\n  pull_request:\njobs:\n  validate:\n    steps:\n      - run: cargo test\n`;
}

function blob(path) {
  return { path, sha: path, type: "blob" };
}
