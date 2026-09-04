import { describe, expect, test } from "bun:test";

import { testingJson, testingPlan } from "../site/testing.js";

describe("GitHub Pages testing scaffold plan", () => {
  test("plans unit tests and Storybook stories without inventing behavioral assertions", () => {
    const plan = testingPlan(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("tsconfig.json", "2"),
          blob("src/math.ts", "3"),
          blob("src/components/Button.tsx", "4"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            dependencies: { react: "19.2.0" },
            scripts: { test: "bun test" },
          }),
        },
      }),
      new Date("2026-09-04T16:00:00.000Z"),
    );

    expect(plan.operation).toBe("remote-testing-scaffold-plan");
    expect(plan.summary.status).toBe("changes-recommended");
    expect(plan.summary.unitTestActionCount).toBe(2);
    expect(plan.summary.storyActionCount).toBe(1);
    expect(plan.summary.setupActionCount).toBe(1);
    expect(plan.actions.find((action) => action.kind === "storybook-setup")?.changes).toEqual([
      {
        path: "package.json",
        operation: "update",
        purpose:
          "Declare Storybook using repository dependency/version policy and expose a storybook script.",
      },
      {
        path: ".storybook/main.ts",
        operation: "create-or-update",
        purpose: "Configure stories for the package without changing application behavior.",
      },
    ]);
    expect(plan.actions.find((action) => action.sourcePath === "src/math.ts")?.targetPath).toBe(
      "tests/math.test.ts",
    );
    expect(plan.actions.find((action) => action.kind === "storybook-story")?.targetPath).toBe(
      "src/components/Button.stories.tsx",
    );
  });

  test("does not recommend already-matched tests or stories", () => {
    const plan = testingPlan(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("tsconfig.json", "2"),
          blob("src/components/Button.tsx", "3"),
          blob("tests/components/Button.test.tsx", "4"),
          blob("src/components/Button.stories.tsx", "5"),
        ],
        files: {
          "package.json": JSON.stringify({
            name: "fixture",
            dependencies: {
              react: "19.2.0",
              storybook: "10.0.0",
            },
            scripts: { test: "bun test" },
          }),
        },
      }),
    );

    expect(plan.summary.status).toBe("ready");
    expect(plan.actions).toEqual([]);
  });

  test("keeps nested package sources owned by the deepest package", () => {
    const plan = testingPlan(
      repository({
        tree: [
          blob("package.json", "1"),
          blob("tsconfig.json", "2"),
          blob("src/root.ts", "3"),
          blob("packages/app/package.json", "4"),
          blob("packages/app/tsconfig.json", "5"),
          blob("packages/app/src/app.ts", "6"),
        ],
        files: {
          "package.json": JSON.stringify({ name: "root", scripts: { test: "bun test" } }),
          "packages/app/package.json": JSON.stringify({
            name: "app",
            scripts: { test: "bun test" },
          }),
        },
      }),
    );

    const appAction = plan.actions.find(
      (action) => action.sourcePath === "packages/app/src/app.ts",
    );
    expect(appAction?.component.path).toBe("packages/app");
    expect(appAction?.targetPath).toBe("packages/app/tests/app.test.ts");
  });

  test("marks truncated remote evidence incomplete", () => {
    const plan = testingPlan(repository({ treeTruncated: true }));
    expect(plan.summary.status).toBe("incomplete");
  });

  test("testingJson resolves through the same public GitHub snapshot seam as analysis", async () => {
    const requests = [];
    const plan = await testingJson("example/repo", {
      now: new Date("2026-09-04T16:30:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/example/repo")
          return jsonResponse(githubRepositoryMetadata());
        if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
          return jsonResponse({ tree: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(plan.repository.fullName).toBe("example/repo");
    expect(plan.generatedAt).toBe("2026-09-04T16:30:00.000Z");
    expect(requests).toHaveLength(2);
  });
});

function repository(overrides = {}) {
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

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}
