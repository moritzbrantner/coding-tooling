import { describe, expect, test } from "bun:test";

import { normalizeArgv, remoteCommandFromSnapshot } from "../site/remote-command.js";

const now = new Date("2026-09-08T16:00:00.000Z");

describe("GitHub Pages CLI URL surface", () => {
  test("parses CLI-style argv including quoted component names", () => {
    expect(normalizeArgv('coding-tooling plan --tier fast --component "web app" --json')).toEqual([
      "plan",
      "--tier",
      "fast",
      "--component",
      "web app",
      "--json",
    ]);
  });

  test("mirrors inspect in a CLI result envelope", () => {
    const result = remoteCommandFromSnapshot(repository(), "inspect --json", now);

    expect(result.operation).toBe("inspect");
    expect(result.status).toBe("passed");
    expect(result.data.root).toBe("github:owner/fixture@main");
    expect(result.data.components).toHaveLength(1);
    expect(result.data.components[0].name).toBe("fixture");
    expect(result.data.remoteScope).toBe("structural");
  });

  test("plans repository-declared validation capabilities without executing them", () => {
    const result = remoteCommandFromSnapshot(repository(), "plan --tier fast --json", now);

    expect(result.operation).toBe("plan");
    expect(result.status).toBe("passed");
    expect(result.data.checks.map((check) => check.capability)).toEqual([
      "format:check",
      "lint",
      "typecheck",
      "test:unit",
      "build",
    ]);
    expect(result.data.remoteScope).toBe("structural-plan-only");
  });

  test("returns structural findings and bootstrap actions through CLI-shaped commands", () => {
    const withGap = repository({ files: { ".coding-tooling.json": undefined } });
    withGap.tree = withGap.tree.filter((entry) => entry.path !== ".coding-tooling.json");

    const findings = remoteCommandFromSnapshot(withGap, "findings --json", now);
    const bootstrap = remoteCommandFromSnapshot(withGap, "bootstrap plan --json", now);

    expect(findings.status).toBe("failed");
    expect(findings.data.findings.some((finding) => finding.id === "REMOTE-FOUNDATION-001")).toBe(
      true,
    );
    expect(bootstrap.data.actions.some((action) => action.id === "REMOTE-FOUNDATION-001")).toBe(
      true,
    );
  });

  test("fails closed for commands that require execution", () => {
    const result = remoteCommandFromSnapshot(repository(), "run --tier fast --strict --json", now);

    expect(result.operation).toBe("run");
    expect(result.status).toBe("unavailable");
    expect(result.data.localCommand).toBe("coding-tooling run --tier fast --strict --json");
    expect(result.diagnostics[0].code).toBe("remote-command-unavailable");
  });
});

function repository(overrides = {}) {
  const { files: fileOverrides = {}, ...rest } = overrides;
  const files = {
    "package.json": JSON.stringify({
      name: "fixture",
      packageManager: "bun@1.4.0",
      scripts: {
        "format:check": "fmt",
        lint: "lint",
        typecheck: "tsc",
        test: "test",
        build: "build",
      },
    }),
    ".coding-tooling.json": JSON.stringify({
      schemaVersion: 1,
      profile: "fixture",
      tiers: { fast: ["format:check", "lint", "typecheck", "test:unit", "build"] },
      requiredCapabilities: ["format:check", "lint", "typecheck", "test:unit", "build"],
    }),
    ...fileOverrides,
  };
  for (const [path, value] of Object.entries(files)) if (value === undefined) delete files[path];

  return {
    repository: {
      owner: "owner",
      name: "fixture",
      fullName: "owner/fixture",
      defaultBranch: "main",
      htmlUrl: "https://github.com/owner/fixture",
      description: null,
      archived: false,
      fork: false,
      stars: 0,
      openIssues: 0,
    },
    tree: [
      blob("package.json", "1"),
      blob("bun.lock", "2"),
      blob("tsconfig.json", "3"),
      blob("src/index.ts", "4"),
      blob("tests/index.test.ts", "5"),
      blob(".coding-tooling.json", "6"),
      blob("AGENTS.md", "7"),
      blob("renovate.json", "8"),
      blob(".github/workflows/validate.yml", "9"),
    ],
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
    ...rest,
  };
}

function blob(path, sha) {
  return { path, sha, type: "blob" };
}
