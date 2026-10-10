import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { parseJavaScriptSourceConfig } from "../src/javascript-source-deps.ts";
import { canonicalGitRepository } from "../src/shared.ts";
import { readSourceDependencyConfig, sourceDependencies } from "../src/source-deps.ts";
import { verifySourceDependencyGraph } from "../src/source-graph.ts";

const WRAPPER = "https://github.com/example/core-wrapper.git";
const UPSTREAM = "https://github.com/example/upstream-core.git";
const REV = "a".repeat(40);

function javascript(upstream: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  return {
    localOnly: true,
    repositories: [
      {
        git: WRAPPER,
        rev: REV,
        localPath: "../core-wrapper",
        packages: [{ package: "core-wrapper" }],
        upstreams: [
          {
            env: "UPSTREAM_CORE_SOURCE_DIR",
            git: UPSTREAM,
            rev: REV,
            localPath: "../up",
            ...upstream,
          },
          ...extra,
        ],
      },
    ],
  };
}

function parse(upstream: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  return parseJavaScriptSourceConfig(javascript(upstream, extra), "config.json", {
    upstreams: true,
  });
}

describe("schema-v5 upstream declarations", () => {
  test("a valid upstream is normalized", () => {
    const parsed = parse({
      rev: REV.toUpperCase(),
      revisionField: "upstreamCore.commit",
    });
    expect(parsed?.repositories[0]?.upstreams).toEqual([
      {
        env: "UPSTREAM_CORE_SOURCE_DIR",
        git: UPSTREAM,
        rev: REV,
        localPath: "../up",
        revisionField: "upstreamCore.commit",
      },
    ]);
  });

  test("upstreams are refused unless the schema allows them", () => {
    expect(() => parseJavaScriptSourceConfig(javascript({}), "config.json")).toThrow(
      "schemaVersion 5",
    );
  });

  test.each([
    [{ env: "PATH" }, "reserved"],
    [{ env: "NODE_OPTIONS" }, "reserved"],
    [{ env: "LD_PRELOAD" }, "reserved"],
    [{ env: "UPSTREAM__DIR" }, "UPPER_SNAKE"],
    [{ localPath: "/abs/upstream" }, "relative"],
    [{ git: WRAPPER }, "repeats the wrapper"],
    [{ revisionField: "a..b" }, "dotted"],
    [{ revisionField: "__proto__.commit" }, "dotted"],
    [{ revisionField: "" }, "revisionField"],
    [{ branch: "main" }, "Unknown upstream field"],
  ])("refuses %j", (upstream, message) => {
    expect(() => parse(upstream)).toThrow(message);
  });

  test("duplicate env names and repeated upstream repositories are refused", () => {
    expect(() =>
      parse({}, [
        {
          env: "UPSTREAM_CORE_SOURCE_DIR",
          git: "https://x/y.git",
          rev: REV,
          localPath: "../y",
        },
      ]),
    ).toThrow("more than once");
    expect(() =>
      parse({}, [
        {
          env: "OTHER_DIR",
          git: `${UPSTREAM.replace(".git", "")}`,
          rev: REV,
          localPath: "../y",
        },
      ]),
    ).toThrow("repeats");
  });

  test("an empty upstream list is refused", () => {
    const config = javascript({});
    config.repositories[0]!.upstreams = [];
    expect(() => parseJavaScriptSourceConfig(config, "config.json", { upstreams: true })).toThrow(
      "non-empty",
    );
  });

  test("upstreams appear as exact-revision source repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-upstream-contract-"));
    writeFileSync(
      join(root, ".coding-tooling.source-deps.json"),
      JSON.stringify({
        schemaVersion: 5,
        cargo: { repositories: [] },
        javascript: javascript({}),
      }),
    );
    const loaded = readSourceDependencyConfig(root);
    expect(loaded.schemaVersion).toBe(5);
    expect(loaded.sourceRepositories).toContainEqual({
      ecosystem: "javascript-upstream",
      git: UPSTREAM,
      rev: REV,
      localPath: "../up",
      localOnly: true,
      packages: [],
      upstreamOf: WRAPPER,
    });

    writeFileSync(
      join(root, ".coding-tooling.source-deps.json"),
      JSON.stringify({
        schemaVersion: 4,
        cargo: { repositories: [] },
        javascript: javascript({}),
      }),
    );
    expect(() => readSourceDependencyConfig(root)).toThrow("schemaVersion 5");
  });
});

describe("#308 review regressions", () => {
  test("repository canonicalisation strips trailing slashes around .git", () => {
    for (const git of [
      "https://github.com/Example/Repo",
      "https://github.com/example/repo/",
      "https://github.com/example/repo.git",
      "https://github.com/example/repo.git/",
      " https://github.com/example/repo.GIT// ",
    ]) {
      expect(canonicalGitRepository(git)).toBe("https://github.com/example/repo");
    }
  });

  test("trailing-slash aliases are duplicates in upstream and repository declarations", () => {
    expect(() => parse({ git: `${WRAPPER}/` })).toThrow("repeats the wrapper");
    expect(() =>
      parse({}, [{ env: "OTHER_DIR", git: `${UPSTREAM}/`, rev: REV, localPath: "../y" }]),
    ).toThrow("repeats");
    const config = javascript({});
    config.repositories.push({
      git: `${WRAPPER}/`,
      rev: REV,
      localPath: "../other",
      packages: [{ package: "other" }],
      upstreams: [],
    });
    expect(() => parseJavaScriptSourceConfig(config, "config.json", { upstreams: true })).toThrow(
      "declared more than once",
    );
  });

  test("verify-graph groups a trailing-slash upstream URL with the same repository", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-upstream-graph-"));
    const consumer = join(workspace, "consumer");
    const heads: Record<string, string> = {
      [join(workspace, "wrapper")]: REV,
      [join(workspace, "up")]: "b".repeat(40),
      [join(workspace, "up-js")]: "c".repeat(40),
    };
    for (const path of [consumer, ...Object.keys(heads)]) mkdirSync(path, { recursive: true });
    writeFileSync(
      join(consumer, ".coding-tooling.source-deps.json"),
      JSON.stringify({
        schemaVersion: 5,
        cargo: { repositories: [] },
        javascript: {
          localOnly: true,
          repositories: [
            {
              git: WRAPPER,
              rev: REV,
              localPath: "../wrapper",
              packages: [{ package: "core-wrapper" }],
              upstreams: [
                { env: "UP_DIR", git: `${UPSTREAM}/`, rev: "b".repeat(40), localPath: "../up" },
              ],
            },
            {
              git: UPSTREAM.replace(".git", ""),
              rev: "c".repeat(40),
              localPath: "../up-js",
              packages: [{ package: "up-js" }],
            },
          ],
        },
      }),
    );
    const result = verifySourceDependencyGraph(consumer, undefined, {
      run: (command, args = [], cwd = "") => {
        const target = args[1] ?? cwd;
        const stdout = args.includes("--show-toplevel") ? target : (heads[target] ?? "");
        return { command: [command, ...args], status: stdout ? 0 : 1, stdout, stderr: "" };
      },
    });
    expect(result.diagnostics.map((value) => value.code)).toContain(
      "source-graph-revision-conflict",
    );
    expect(result.data.conflicts).toEqual([
      expect.objectContaining({
        repository: "https://github.com/example/upstream-core",
        revisions: ["b".repeat(40), "c".repeat(40)],
      }),
    ]);
  });

  test.each(["consumer", "wrapper"])(
    "a symlink alias of the %s checkout is refused as an upstream",
    (target) => {
      const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-upstream-alias-"));
      const consumer = join(workspace, "consumer");
      mkdirSync(consumer, { recursive: true });
      mkdirSync(join(workspace, "core-wrapper"), { recursive: true });
      symlinkSync(
        join(workspace, target === "consumer" ? "consumer" : "core-wrapper"),
        join(workspace, "alias"),
      );
      writeFileSync(
        join(consumer, ".coding-tooling.source-deps.json"),
        JSON.stringify({
          schemaVersion: 5,
          cargo: { repositories: [] },
          javascript: javascript({ localPath: "../alias" }),
        }),
      );
      const activated = sourceDependencies(consumer, "activate");
      expect(activated.status).toBe("error");
      expect(activated.diagnostics[0]?.message).toContain(
        "must not resolve to the consumer or wrapper checkout",
      );
    },
  );
});
