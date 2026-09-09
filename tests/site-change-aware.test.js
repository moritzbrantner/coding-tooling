import { describe, expect, test } from "bun:test";

import {
  isChangeAwareArgv,
  remoteChangeCommand,
  remoteChangeCommandFromSnapshot,
} from "../site/change-aware.js";

const now = new Date("2026-09-09T06:00:00.000Z");

describe("GitHub Pages change-aware analysis", () => {
  test("routes affected and change-aware plans without hijacking ordinary plans", () => {
    expect(isChangeAwareArgv("affected --base main --json")).toBe(true);
    expect(isChangeAwareArgv("plan --tier fast --base main --json")).toBe(true);
    expect(isChangeAwareArgv("plan --tier fast --changed-file src/index.ts --json")).toBe(true);
    expect(isChangeAwareArgv("plan --tier fast --json")).toBe(false);
    expect(isChangeAwareArgv("inspect --json")).toBe(false);
  });

  test("narrows validation to the most specific affected component", () => {
    const result = remoteChangeCommandFromSnapshot(
      repository(),
      change(["packages/a/src/widget.ts"]),
      request("affected"),
      now,
    );

    expect(result.operation).toBe("affected");
    expect(result.status).toBe("passed");
    expect(result.data.scope.mode).toBe("targeted");
    expect(result.data.scope.affectedComponents.map((component) => component.name)).toEqual([
      "package-a",
    ]);
    expect(new Set(result.data.validationPlan.checks.map((check) => check.component))).toEqual(
      new Set(["package-a"]),
    );
    expect(result.data.scope.affectedComponents[0].candidateTests).toContain(
      "packages/a/tests/widget.test.ts",
    );
    expect(result.data.scope.affectedComponents[0].governingContracts).toContain(
      "packages/a/package.json",
    );
  });

  test("widens cross-repository contract changes to all discovered components", () => {
    const result = remoteChangeCommandFromSnapshot(
      repository(),
      change([".coding-tooling.json"]),
      request("affected"),
      now,
    );

    expect(result.data.scope.mode).toBe("conservative-all");
    expect(
      result.data.scope.affectedComponents.map((component) => component.name).toSorted(),
    ).toEqual(["fixture", "package-a", "package-b"]);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "remote-change-scope-widened"),
    ).toBe(true);
  });

  test("keeps documentation-only changes out of code validation", () => {
    const result = remoteChangeCommandFromSnapshot(
      repository(),
      change(["README.md", "docs/architecture.md"]),
      request("affected"),
      now,
    );

    expect(result.status).toBe("passed");
    expect(result.data.scope.mode).toBe("documentation-only");
    expect(result.data.scope.affectedComponents).toEqual([]);
    expect(result.data.validationPlan.checks).toEqual([]);
  });

  test("widening is fail-closed when the repository snapshot is incomplete", () => {
    const snapshot = repository({ manifestFetchTruncated: true });
    const result = remoteChangeCommandFromSnapshot(
      snapshot,
      change(["packages/a/src/widget.ts"]),
      request("affected"),
      now,
    );

    expect(result.status).toBe("unavailable");
    expect(result.data.scope.mode).toBe("conservative-all");
    expect(result.data.scope.affectedComponents).toHaveLength(3);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "remote-change-source-incomplete",
      ),
    ).toBe(true);
  });

  test("fails closed when an affected component cannot satisfy a required tier capability", () => {
    const snapshot = repository({
      files: {
        ".coding-tooling.json": JSON.stringify({
          schemaVersion: 1,
          tiers: { fast: ["lint", "test:e2e"] },
          requiredCapabilities: ["lint", "test:e2e"],
        }),
      },
    });
    const result = remoteChangeCommandFromSnapshot(
      snapshot,
      change(["packages/a/src/widget.ts"]),
      request("affected"),
      now,
    );

    expect(result.status).toBe("unavailable");
    expect(result.data.validationPlan.missing).toEqual([
      { capability: "test:e2e", component: "package-a", optional: false },
    ]);
  });

  test("change-aware plan honors an affected component filter", () => {
    const result = remoteChangeCommandFromSnapshot(
      repository(),
      change(["packages/a/src/widget.ts", "packages/b/src/index.ts"]),
      request("plan", { component: "package-b" }),
      now,
    );

    expect(result.operation).toBe("plan");
    expect(result.status).toBe("passed");
    expect(new Set(result.data.checks.map((check) => check.component))).toEqual(
      new Set(["package-b"]),
    );
    expect(result.data.remoteScope).toBe("change-aware-structural-plan-only");
  });

  test("loads GitHub compare evidence and analyzes the requested head", async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.endsWith("/repos/owner/fixture")) return jsonResponse(repositoryMetadata());
      if (url.includes("/compare/main...feature"))
        return jsonResponse({
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          files: [{ filename: "src/index.ts", status: "modified" }],
        });
      if (url.includes("/git/trees/feature?recursive=1"))
        return jsonResponse({ tree: repository().tree, truncated: false });
      const sha = url.split("/").at(-1);
      const contents = blobContents()[sha];
      if (contents !== undefined)
        return jsonResponse({ encoding: "base64", content: btoa(contents) });
      return new Response("not found", { status: 404 });
    };

    const result = await remoteChangeCommand(
      "owner/fixture",
      "affected --base main --head feature --json",
      { fetchImpl, now },
    );

    expect(result.status).toBe("passed");
    expect(result.data.change.origin).toBe("github-compare");
    expect(result.data.change.head).toBe("feature");
    expect(result.data.change.files[0].path).toBe("src/index.ts");
    expect(requests.some((url) => url.includes("/compare/main...feature"))).toBe(true);
    expect(requests.some((url) => url.includes("/git/trees/feature?recursive=1"))).toBe(true);
  });

  test("accepts explicit changed paths without calling GitHub compare", async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.endsWith("/repos/owner/fixture")) return jsonResponse(repositoryMetadata());
      if (url.includes("/git/trees/main?recursive=1"))
        return jsonResponse({ tree: repository().tree, truncated: false });
      const sha = url.split("/").at(-1);
      const contents = blobContents()[sha];
      if (contents !== undefined)
        return jsonResponse({ encoding: "base64", content: btoa(contents) });
      return new Response("not found", { status: 404 });
    };

    const result = await remoteChangeCommand(
      "owner/fixture",
      ["affected", "--changed-file", "src/index.ts", "--json"],
      { fetchImpl, now },
    );

    expect(result.status).toBe("passed");
    expect(result.data.change.origin).toBe("provided-paths");
    expect(requests.some((url) => url.includes("/compare/"))).toBe(false);
  });
});

function request(operation, overrides = {}) {
  return {
    operation,
    tier: "fast",
    component: undefined,
    base: "main",
    head: "feature",
    changedFiles: [],
    ...overrides,
  };
}

function change(paths) {
  return {
    base: "main",
    head: "feature",
    origin: "provided-paths",
    filesTruncated: false,
    compareIncomplete: false,
    files: paths.map((path) => ({ path, status: "modified" })),
  };
}

function repository(overrides = {}) {
  const { files: fileOverrides = {}, ...rest } = overrides;
  const files = {
    "package.json": JSON.stringify(packageManifest("fixture")),
    "packages/a/package.json": JSON.stringify(packageManifest("package-a")),
    "packages/b/package.json": JSON.stringify(packageManifest("package-b")),
    ".coding-tooling.json": JSON.stringify({
      schemaVersion: 1,
      profile: "fixture",
      tiers: { fast: ["format:check", "lint", "typecheck", "test:unit", "build"] },
      requiredCapabilities: ["format:check", "lint", "typecheck", "test:unit", "build"],
      capabilityCommands: {
        "packages/a": {
          "format:check": ["bun", "run", "format:check"],
          lint: ["bun", "run", "lint"],
          typecheck: ["bun", "run", "typecheck"],
          "test:unit": ["bun", "run", "test:unit"],
          build: ["bun", "run", "build"],
        },
        "packages/b": {
          "format:check": ["bun", "run", "format:check"],
          lint: ["bun", "run", "lint"],
          typecheck: ["bun", "run", "typecheck"],
          "test:unit": ["bun", "run", "test:unit"],
          build: ["bun", "run", "build"],
        },
      },
    }),
    ...fileOverrides,
  };
  const tree = [
    blob("package.json", "1"),
    blob("packages/a/package.json", "2"),
    blob("packages/b/package.json", "3"),
    blob("src/index.ts", "4"),
    blob("tests/index.test.ts", "5"),
    blob("packages/a/src/widget.ts", "6"),
    blob("packages/a/tests/widget.test.ts", "7"),
    blob("packages/b/src/index.ts", "8"),
    blob("packages/b/tests/index.test.ts", "9"),
    blob(".coding-tooling.json", "10"),
    blob("AGENTS.md", "11"),
    blob("renovate.json", "12"),
    blob(".github/workflows/validate.yml", "13"),
    blob("README.md", "14"),
    blob("docs/architecture.md", "15"),
    blob("bun.lock", "16"),
    blob("tsconfig.json", "17"),
  ];

  return {
    repository: snapshotRepositoryMetadata(),
    tree,
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
    ...rest,
  };
}

function packageManifest(name) {
  return {
    name,
    packageManager: "bun@1.4.0",
    scripts: {
      "format:check": "fmt",
      lint: "lint",
      typecheck: "tsc",
      test: "test",
      "test:unit": "test:unit",
      build: "build",
    },
  };
}

function repositoryMetadata() {
  return {
    owner: { login: "owner" },
    name: "fixture",
    full_name: "owner/fixture",
    default_branch: "main",
    html_url: "https://github.com/owner/fixture",
    description: null,
    archived: false,
    fork: false,
    stargazers_count: 0,
    open_issues_count: 0,
  };
}

function snapshotRepositoryMetadata() {
  return {
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
  };
}

function blobContents() {
  const snapshot = repository();
  return Object.fromEntries(
    snapshot.tree.map((entry) => [entry.sha, snapshot.files[entry.path] ?? ""]),
  );
}

function blob(path, sha) {
  return { path, sha, type: "blob" };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
