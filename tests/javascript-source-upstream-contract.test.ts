import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { parseJavaScriptSourceConfig } from "../src/javascript-source-deps.ts";
import { readSourceDependencyConfig } from "../src/source-deps.ts";

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
