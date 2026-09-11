import { describe, expect, test } from "bun:test";

import { analysisJson, loadSnapshot } from "../site/github-analysis.js";
import {
  analyzeSnapshot,
  parseRepositoryReference,
  selectedRemoteFiles,
  selectedWorkflowFiles,
} from "../site/preflight.js";

describe("GitHub Pages repository preflight", () => {
  test("parses shorthand and GitHub URLs", () => {
    expect(parseRepositoryReference("moritzbrantner/coding-tooling")).toEqual({
      owner: "moritzbrantner",
      name: "coding-tooling",
    });
    expect(
      parseRepositoryReference("https://github.com/moritzbrantner/coding-tooling/tree/main/src"),
    ).toEqual({ owner: "moritzbrantner", name: "coding-tooling" });
    expect(parseRepositoryReference("https://example.com/owner/repo")).toBeNull();
  });

  test("prioritizes remote foundation evidence before nested manifests", () => {
    const tree = [
      blob("packages/app/package.json", "1"),
      blob("package.json", "2"),
      blob(".coding-tooling.json", "3"),
      blob(".node-version", "4"),
      blob("fixtures/app/package.json", "5"),
    ];
    expect(selectedRemoteFiles(tree, 3).map((entry) => entry.path)).toEqual([
      ".coding-tooling.json",
      ".node-version",
      "package.json",
    ]);
    expect(selectedRemoteFiles(tree).map((entry) => entry.path)).not.toContain(
      "fixtures/app/package.json",
    );
  });

  test("selects GitHub workflow evidence separately from the manifest budget", () => {
    const tree = [
      blob("package.json", "1"),
      blob(".github/workflows/pages.yml", "2"),
      blob(".github/workflows/validate.yml", "3"),
    ];
    expect(selectedRemoteFiles(tree).map((entry) => entry.path)).toEqual(["package.json"]);
    expect(selectedWorkflowFiles(tree).map((entry) => entry.path)).toEqual([
      ".github/workflows/pages.yml",
      ".github/workflows/validate.yml",
    ]);
  });

  test("returns a ready result for a repository with structural foundation evidence", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("tsconfig.json", "2"),
          blob("bun.lock", "3"),
          blob("src/index.ts", "4"),
          blob("tests/index.test.ts", "5"),
          blob(".coding-tooling.json", "6"),
          blob(".node-version", "7"),
          blob("AGENTS.md", "8"),
          blob("renovate.json", "9"),
          blob(".github/workflows/validate.yml", "10"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".node-version": "24.20.0\n",
          ".github/workflows/validate.yml": validatingWorkflow(),
        },
      }),
      new Date("2026-09-02T18:00:00.000Z"),
    );
    expect(analysis.summary.status).toBe("ready");
    expect(analysis.technologies).toEqual(["javascript", "typescript"]);
    expect(analysis.findings).toEqual([]);
  });

  test("ignores fixture components and accepts an exact Bun toolchain pin", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("bun.lock", "2"),
          blob("src/index.ts", "3"),
          blob("tests/index.test.ts", "4"),
          blob(".coding-tooling.json", "5"),
          blob("AGENTS.md", "6"),
          blob("renovate.json", "7"),
          blob(".github/workflows/validate.yml", "8"),
          blob("fixtures/app/package.json", "9"),
          blob("fixtures/rust/Cargo.toml", "10"),
          blob("fixtures/dotnet/App.csproj", "11"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4.0",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/validate.yml": validatingWorkflow(),
          "fixtures/app/package.json": JSON.stringify({ name: "ignored-fixture" }),
        },
      }),
    );
    expect(analysis.components.map((component) => [component.kind, component.path])).toEqual([
      ["package", "."],
    ]);
    expect(analysis.findings).toEqual([]);
  });

  test("reports a non-exact Bun toolchain pin", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob(".coding-tooling.json", "2"),
          blob("AGENTS.md", "3"),
          blob("renovate.json", "4"),
          blob(".github/workflows/validate.yml", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4",
            scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/validate.yml": validatingWorkflow(),
        },
      }),
    );
    expect(analysis.findings.map((finding) => finding.id)).toEqual(["REMOTE-ENV-005"]);
  });

  test("does not treat deployment-only automation as validation", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob(".coding-tooling.json", "2"),
          blob("AGENTS.md", "3"),
          blob("renovate.json", "4"),
          blob(".github/workflows/pages.yml", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4.0",
            scripts: { test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/pages.yml": `name: Validate
on:
  pull_request:
jobs:
  deploy:
    steps:
      - uses: actions/deploy-pages@0123456789012345678901234567890123456789
`,
        },
      }),
    );
    expect(analysis.validationEvidence).toEqual(
      expect.objectContaining({
        status: "finding",
        reason: "automation-without-validation-evidence",
      }),
    );
    expect(analysis.findings.map((finding) => finding.id)).toContain("REMOTE-CI-002");
  });

  test("reports a production-only Pages runtime variant without exact-artifact browser verification", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob(".coding-tooling.json", "2"),
          blob("AGENTS.md", "3"),
          blob("renovate.json", "4"),
          blob(".github/workflows/pages.yml", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4.0",
            scripts: { test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/pages.yml": `name: Pages
on:
  pull_request:
permissions:
  pages: write
jobs:
  build:
    steps:
      - run: VITE_HOSTED_RUNTIME=1 bunx vite build --base /fixture/
      - uses: actions/upload-pages-artifact@0123456789012345678901234567890123456789
  smoke:
    steps:
      - run: bun run test:browser:smoke
`,
        },
      }),
    );
    expect(analysis.findings.some((finding) => finding.id.startsWith("REMOTE-DEPLOY-"))).toBe(true);
  });

  test("ignores remote public runtime variables outside build commands", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob(".coding-tooling.json", "2"),
          blob("AGENTS.md", "3"),
          blob("renovate.json", "4"),
          blob(".github/workflows/pages.yml", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4.0",
            scripts: { test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/pages.yml": `name: Pages
on:
  pull_request:
permissions:
  pages: write
jobs:
  build:
    steps:
      - run: bun run build
      - uses: actions/upload-pages-artifact@0123456789012345678901234567890123456789
  diagnostics:
    steps:
      - run: VITE_DIAGNOSTIC_MODE=1 bun run inspect
`,
        },
      }),
    );
    expect(analysis.findings.some((finding) => finding.id.startsWith("REMOTE-DEPLOY-"))).toBe(
      false,
    );
  });

  test("accepts remote Pages runtime verification that consumes the produced artifact", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("package.json", "1"),
          blob(".coding-tooling.json", "2"),
          blob("AGENTS.md", "3"),
          blob("renovate.json", "4"),
          blob(".github/workflows/pages.yml", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            packageManager: "bun@1.4.0",
            scripts: { test: "test" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/pages.yml": `name: Pages
on:
  pull_request:
permissions:
  pages: write
jobs:
  build:
    uses: owner/reusable/.github/workflows/build-artifact.yml@0123456789012345678901234567890123456789
    with:
      build_command: VITE_HOSTED_RUNTIME=1 bunx vite build --base /fixture/
      artifact_paths: dist
  verify:
    needs: build
    uses: owner/reusable/.github/workflows/e2e-validation.yml@0123456789012345678901234567890123456789
    with:
      prebuilt_artifact_run_id: producer-run
      prebuilt_artifact_digest: producer-digest
      e2e_command: bunx playwright test --config playwright.hosted.config.ts
  deploy:
    needs: [build, verify]
    uses: owner/reusable/.github/workflows/deploy-pages.yml@0123456789012345678901234567890123456789
`,
        },
      }),
    );
    expect(analysis.findings.some((finding) => finding.id.startsWith("REMOTE-DEPLOY-"))).toBe(
      false,
    );
  });

  test("represents external CI as unsupported rather than missing validation", () => {
    const analysis = analyzeSnapshot(
      repository({
        tree: [blob(".gitlab-ci.yml", "1")],
        files: {},
      }),
    );
    expect(analysis.validationEvidence).toEqual(
      expect.objectContaining({
        status: "unsupported",
        provider: "external",
      }),
    );
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("REMOTE-CI-001");
    expect(analysis.findings.map((finding) => finding.id)).not.toContain("REMOTE-CI-002");
  });

  test("marks truncated or bounded GitHub evidence incomplete", () => {
    const treeTruncated = analyzeSnapshot(repository({ tree: [], treeTruncated: true }));
    expect(treeTruncated.summary.status).toBe("incomplete");
    expect(treeTruncated.findings.map((finding) => finding.id)).toContain("REMOTE-SOURCE-001");

    const manifestBounded = analyzeSnapshot(
      repository({ tree: [blob("package.json", "1")], manifestFetchTruncated: true }),
    );
    expect(manifestBounded.summary.status).toBe("incomplete");
    expect(manifestBounded.findings.map((finding) => finding.id)).toContain("REMOTE-SOURCE-002");
  });

  test("does not count ignored manifests against the remote fetch budget", async () => {
    const snapshot = await loadSnapshot(
      { owner: "example", name: "repo" },
      {
        fetchImpl: async (url) => {
          if (url === "https://api.github.com/repos/example/repo")
            return jsonResponse(githubRepositoryMetadata());
          if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
            return jsonResponse({
              tree: [
                blob("package.json", "root"),
                blob("fixtures/app/package.json", "fixture-app"),
                blob("fixtures/other/package.json", "fixture-other"),
                blob("vendor/tool/package.json", "vendor-tool"),
              ],
              truncated: false,
            });
          if (url === "https://api.github.com/repos/example/repo/git/blobs/root")
            return encodedBlob(JSON.stringify({ name: "repo", packageManager: "bun@1.4.0" }));
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    expect(snapshot.manifestFetchTruncated).toBe(false);
    expect(Object.keys(snapshot.files)).toEqual(["package.json"]);
  });

  test("still marks a real eligible manifest budget overflow incomplete", async () => {
    const manifests = Array.from({ length: 25 }, (_, index) =>
      blob(`packages/package-${String(index).padStart(2, "0")}/package.json`, `package-${index}`),
    );
    const snapshot = await loadSnapshot(
      { owner: "example", name: "repo" },
      {
        fetchImpl: async (url) => {
          if (url === "https://api.github.com/repos/example/repo")
            return jsonResponse(githubRepositoryMetadata());
          if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
            return jsonResponse({ tree: manifests, truncated: false });
          if (url.includes("/git/blobs/package-"))
            return encodedBlob(JSON.stringify({ name: "fixture" }));
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    expect(snapshot.manifestFetchTruncated).toBe(true);
    expect(Object.keys(snapshot.files)).toHaveLength(24);
  });

  test("scopes structural test evidence to sibling components", () => {
    function manifest(name) {
      return {
        name,
        packageManager: "bun@1.4.0",
        scripts: { "format:check": "fmt", lint: "lint", typecheck: "tsc", test: "test" },
      };
    }
    const analysis = analyzeSnapshot(
      repository({
        tree: [
          blob("packages/a/package.json", "1"),
          blob("packages/a/src/index.ts", "2"),
          blob("packages/a/tests/index.test.ts", "3"),
          blob("packages/b/package.json", "4"),
          blob("packages/b/src/index.ts", "5"),
          blob(".coding-tooling.json", "6"),
          blob("AGENTS.md", "7"),
          blob("renovate.json", "8"),
          blob(".github/workflows/validate.yml", "9"),
        ],
        files: {
          "packages/a/package.json": JSON.stringify(manifest("package-a")),
          "packages/b/package.json": JSON.stringify(manifest("package-b")),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
          ".github/workflows/validate.yml": validatingWorkflow(),
        },
      }),
    );
    const packageA = analysis.components.find((component) => component.name === "package-a");
    const packageB = analysis.components.find((component) => component.name === "package-b");
    expect(packageA.testEvidence).toEqual(
      expect.objectContaining({ status: "satisfied", testPathCount: 1 }),
    );
    expect(packageB.testEvidence).toEqual(
      expect.objectContaining({ status: "finding", testPathCount: 0 }),
    );
    expect(
      analysis.findings
        .filter((finding) => finding.id.startsWith("REMOTE-TEST-001"))
        .map((finding) => finding.title),
    ).toEqual(["package-b: No structural test files detected"]);
  });

  test("analysisJson resolves a repository through the public GitHub API seam", async () => {
    const requests = [];
    const analysis = await analysisJson("example/repo", {
      now: new Date("2026-09-02T20:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({ tree: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(analysis.operation).toBe("remote-preflight");
    expect(analysis.repository.fullName).toBe("example/repo");
    expect(analysis.generatedAt).toBe("2026-09-02T20:00:00.000Z");
    expect(requests).toHaveLength(6);
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
    workflowFetchTruncated: false,
    unreadablePaths: [],
    ...overrides,
  };
}

function validatingWorkflow() {
  return `name: Anything
on:
  pull_request:
jobs:
  verify:
    steps:
      - run: bun run typecheck
`;
}

function githubRepositoryMetadata() {
  return {
    owner: { login: "example" },
    name: "repo",
    full_name: "example/repo",
    default_branch: "main",
    html_url: "https://github.com/example/repo",
    description: "fixture",
    archived: false,
    fork: false,
    stargazers_count: 3,
    open_issues_count: 1,
  };
}

function blob(path, sha) {
  return { path, sha, type: "blob" };
}

function encodedBlob(content) {
  return jsonResponse({ encoding: "base64", content: btoa(content) });
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
