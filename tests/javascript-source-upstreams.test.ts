// Acceptance for #308: a JavaScript distribution-wrapper package whose build consumes a declared
// exact-revision local upstream checkout (the nlp-stack-wasm ← nlp-stack case).
//
// Pinned contract (independent acceptance, written before the implementation):
// - `.coding-tooling.source-deps.json` schemaVersion 5 = schema v4 plus an optional `upstreams`
//   array on a JavaScript source repository. Schema v4 rejects `upstreams` (older contracts must
//   not silently gain new semantics).
// - Each upstream declares `env` (an UPPER_SNAKE environment variable name), `git`, an exact
//   40-character `rev`, a consumer-relative `localPath`, and an optional `revisionField`: a
//   dotted path in the wrapper's package.json that must equal `rev` (e.g. `nlpStack.commit`).
// - `source-deps activate` validates the upstream checkout's HEAD against `rev` (local-only, never
//   fetched) and runs the wrapper build with `env` set to the upstream checkout's absolute path.
// - `source-deps verify-graph` treats upstreams as exact-revision graph nodes: a disagreement with
//   another declaration of the same repository is `source-graph-revision-conflict`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { sourceDependencies } from "../src/source-deps.ts";
import { verifySourceDependencyGraph } from "../src/source-graph.ts";

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function writePackage(
  root: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
}

function gitCommit(root: string, message = "source"): string {
  if (spawnSync("git", ["-C", root, "rev-parse", "--git-dir"]).status !== 0) {
    expect(spawnSync("git", ["init", "--initial-branch=main", root]).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]).status).toBe(
      0,
    );
    expect(spawnSync("git", ["-C", root, "config", "user.name", "Test"]).status).toBe(0);
  }
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "commit", "-m", message]).status).toBe(0);
  return run("git", ["rev-parse", "HEAD"], root);
}

const UPSTREAM_GIT = "https://github.com/example/upstream-core.git";
const WRAPPER_GIT = "https://github.com/example/core-wrapper.git";

type Fixture = {
  workspace: string;
  consumer: string;
  upstream: string;
  wrapper: string;
  upstreamRevision: string;
  wrapperRevision: string;
};

function fixture(options: { pinnedUpstreamRevision?: (actual: string) => string } = {}): Fixture {
  const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-js-upstreams-"));
  const upstream = join(workspace, "upstream-core");
  const wrapper = join(workspace, "core-wrapper");
  const fallback = join(workspace, "fallback-wrapper");
  const consumer = join(workspace, "consumer");

  // The upstream is not a JavaScript package: it is the source the wrapper builds from.
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, "core.txt"), "upstream-local\n");
  const upstreamRevision = gitCommit(upstream, "upstream");

  writePackage(
    fallback,
    { name: "core-wrapper", version: "1.0.0", type: "module", exports: "./index.js" },
    { "index.js": 'export const value = "registry-wrapper";\n' },
  );

  // The wrapper's build reads the upstream checkout it is given through the declared env var;
  // without it, it would build from its own pinned (network) upstream, which tests must not hit.
  const pinned = options.pinnedUpstreamRevision?.(upstreamRevision) ?? upstreamRevision;
  writePackage(
    wrapper,
    {
      name: "core-wrapper",
      version: "1.0.0",
      type: "module",
      files: ["pkg"],
      exports: "./pkg/index.js",
      scripts: { build: "bun build.ts" },
      upstreamCore: { commit: pinned },
    },
    {
      "build.ts": [
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.env.UPSTREAM_CORE_SOURCE_DIR;",
        'if (!dir) { console.error("UPSTREAM_CORE_SOURCE_DIR is not set"); process.exit(3); }',
        'const core = readFileSync(join(dir, "core.txt"), "utf8").trim();',
        'mkdirSync("pkg", { recursive: true });',
        'writeFileSync("pkg/index.js", `export const value = ${JSON.stringify(`${core}-wrapped`)};\\n`);',
        "",
      ].join("\n"),
    },
  );
  run("bun", ["install"], wrapper);
  const wrapperRevision = gitCommit(wrapper, "wrapper");

  writePackage(consumer, {
    name: "consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { "core-wrapper": "file:../fallback-wrapper" },
  });
  run("bun", ["install"], consumer);
  return { workspace, consumer, upstream, wrapper, upstreamRevision, wrapperRevision };
}

function declare(
  { consumer, wrapperRevision, upstreamRevision }: Fixture,
  overrides: {
    schemaVersion?: number;
    upstream?: Record<string, unknown>;
    extraRepositories?: Array<Record<string, unknown>>;
  } = {},
): void {
  writeFileSync(
    join(consumer, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: overrides.schemaVersion ?? 5,
        cargo: { repositories: [] },
        javascript: {
          localOnly: true,
          repositories: [
            {
              git: WRAPPER_GIT,
              rev: wrapperRevision,
              localPath: "../core-wrapper",
              packages: [{ package: "core-wrapper" }],
              upstreams: [
                {
                  env: "UPSTREAM_CORE_SOURCE_DIR",
                  git: UPSTREAM_GIT,
                  rev: upstreamRevision,
                  localPath: "../upstream-core",
                  revisionField: "upstreamCore.commit",
                  ...overrides.upstream,
                },
              ],
            },
            ...(overrides.extraRepositories ?? []),
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function importedValue(root: string, packageName: string): string {
  return run(
    "bun",
    ["-e", `import(${JSON.stringify(packageName)}).then((module) => console.log(module.value))`],
    root,
  );
}

describe("JavaScript wrapper packages built from a declared local upstream", () => {
  test("activation builds the wrapper from the exact local upstream and restore undoes it", () => {
    const setup = fixture();
    declare(setup);

    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status, JSON.stringify(activated.diagnostics)).toBe("passed");
    expect(importedValue(setup.consumer, "core-wrapper")).toBe("upstream-local-wrapped");

    const status = sourceDependencies(setup.consumer, "status");
    expect(status.status).toBe("passed");
    expect(sourceDependencies(setup.consumer, "smoke").status).toBe("passed");

    expect(sourceDependencies(setup.consumer, "deactivate").status).toBe("passed");
    expect(importedValue(setup.consumer, "core-wrapper")).toBe("registry-wrapper");
  });

  test("local upstream edits are picked up only at the declared revision", () => {
    const setup = fixture();
    writeFileSync(join(setup.upstream, "core.txt"), "upstream-advanced\n");
    const advanced = gitCommit(setup.upstream, "advanced");
    // Still declared at the old revision: activation must refuse instead of building HEAD.
    declare(setup);
    const stale = sourceDependencies(setup.consumer, "activate");
    expect(stale.status).toBe("error");
    expect(stale.diagnostics.map((value) => value.message).join("\n")).toContain("expected");

    // Advancing both the declaration and the wrapper's own pin builds the new upstream.
    const pinnedFixture = { ...setup, upstreamRevision: advanced };
    writePackage(setup.wrapper, {
      name: "core-wrapper",
      version: "1.0.0",
      type: "module",
      files: ["pkg"],
      exports: "./pkg/index.js",
      scripts: { build: "bun build.ts" },
      upstreamCore: { commit: advanced },
    });
    pinnedFixture.wrapperRevision = gitCommit(setup.wrapper, "advance upstream pin");
    declare(pinnedFixture);
    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status, JSON.stringify(activated.diagnostics)).toBe("passed");
    expect(importedValue(setup.consumer, "core-wrapper")).toBe("upstream-advanced-wrapped");
    sourceDependencies(setup.consumer, "deactivate");
  });

  test("the wrapper's own upstream pin must agree with the declared upstream revision", () => {
    const setup = fixture({ pinnedUpstreamRevision: () => "0".repeat(40) });
    declare(setup);
    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status).toBe("error");
    expect(activated.diagnostics.map((value) => value.message).join("\n")).toContain(
      "upstreamCore.commit",
    );
  });

  test("a missing upstream checkout is an error, never a network fallback", () => {
    const setup = fixture();
    declare(setup, { upstream: { localPath: "../missing-upstream" } });
    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status).toBe("error");
  });

  test("invalid upstream declarations are refused", () => {
    for (const upstream of [
      { env: "lower_case" },
      { env: "" },
      { rev: "abc123" },
      { git: undefined },
      { localPath: undefined },
    ]) {
      const setup = fixture();
      declare(setup, { upstream });
      expect(sourceDependencies(setup.consumer, "activate").status).toBe("error");
    }
  });

  test("schema version 4 rejects upstreams instead of silently ignoring them", () => {
    const setup = fixture();
    declare(setup, { schemaVersion: 4 });
    expect(sourceDependencies(setup.consumer, "activate").status).toBe("error");
  });
});

describe("upstreams in the exact source graph", () => {
  test("a coherent graph with an upstream verifies", () => {
    const setup = fixture();
    declare(setup);
    const result = verifySourceDependencyGraph(setup.consumer);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("passed");
    expect(result.data.conflicts).toEqual([]);
  });

  test("an upstream that disagrees with another declaration of the same repository conflicts", () => {
    const setup = fixture();
    writeFileSync(join(setup.upstream, "core.txt"), "upstream-advanced\n");
    const advanced = gitCommit(setup.upstream, "advanced");
    // The upstream checkout is now at `advanced`; another declaration in the graph requires it
    // there while the wrapper's upstream still requires the original revision.
    mkdirSync(join(setup.workspace, "upstream-core-js"), { recursive: true });
    declare(setup, {
      upstream: { revisionField: undefined },
      extraRepositories: [
        {
          git: UPSTREAM_GIT,
          rev: advanced,
          localPath: "../upstream-core",
          packages: [{ package: "upstream-core-js" }],
        },
      ],
    });
    const result = verifySourceDependencyGraph(setup.consumer);
    expect(result.status).not.toBe("passed");
    expect(result.diagnostics.map((value) => value.code)).toContain(
      "source-graph-revision-conflict",
    );
  });

  test("an upstream checkout away from its declared revision does not verify", () => {
    const setup = fixture();
    declare(setup);
    writeFileSync(join(setup.upstream, "core.txt"), "drifted\n");
    gitCommit(setup.upstream, "drift");
    expect(verifySourceDependencyGraph(setup.consumer).status).not.toBe("passed");
  });
});
