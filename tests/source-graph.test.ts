import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { verifySourceDependencyGraph } from "../src/source-graph.ts";

function initialize(root: string): void {
  mkdirSync(root, { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=main", root]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.name", "Test"]).status).toBe(0);
}

function commit(root: string, message: string): string {
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "commit", "-m", message]).status).toBe(0);
  return spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function config(
  root: string,
  repositories: Array<{ git: string; rev: string; localPath: string; package: string }>,
): void {
  writeFileSync(
    join(root, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        cargo: {
          localOnly: true,
          repositories: repositories.map((repository) => ({
            git: repository.git,
            rev: repository.rev,
            localPath: repository.localPath,
            packages: [{ package: repository.package }],
          })),
        },
      },
      null,
      2,
    )}\n`,
  );
}

function fixture(): {
  consumer: string;
  middle: string;
  foundation: string;
  foundationRevision: string;
  middleRevision: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-source-graph-"));
  const foundation = join(workspace, "foundation");
  const middle = join(workspace, "middle");
  const consumer = join(workspace, "consumer");
  initialize(foundation);
  initialize(middle);
  initialize(consumer);
  writeFileSync(join(foundation, "README.md"), "foundation\n");
  const foundationRevision = commit(foundation, "foundation");
  config(middle, [
    {
      git: "https://github.com/example/foundation.git",
      rev: foundationRevision,
      localPath: "../foundation",
      package: "foundation-package",
    },
  ]);
  const middleRevision = commit(middle, "middle");
  return { consumer, middle, foundation, foundationRevision, middleRevision };
}

test("verifies a coherent transitive exact-source graph", () => {
  const { consumer, foundationRevision, middleRevision } = fixture();
  config(consumer, [
    {
      git: "https://github.com/example/middle.git",
      rev: middleRevision,
      localPath: "../middle",
      package: "middle-package",
    },
    {
      git: "https://github.com/example/foundation.git",
      rev: foundationRevision,
      localPath: "../foundation",
      package: "foundation-package",
    },
  ]);

  const result = verifySourceDependencyGraph(consumer);
  expect(result.status).toBe("passed");
  expect(result.data.conflicts).toEqual([]);
});

test("fails when a root override conflicts with an intermediate source contract", () => {
  const { consumer, foundation, middleRevision } = fixture();
  writeFileSync(join(foundation, "README.md"), "foundation-advanced\n");
  const advancedRevision = commit(foundation, "foundation advanced");
  config(consumer, [
    {
      git: "https://github.com/example/middle.git",
      rev: middleRevision,
      localPath: "../middle",
      package: "middle-package",
    },
    {
      git: "https://github.com/example/foundation.git",
      rev: advancedRevision,
      localPath: "../foundation",
      package: "foundation-package",
    },
  ]);

  const result = verifySourceDependencyGraph(consumer);
  expect(result.status).toBe("failed");
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "source-graph-revision-conflict",
  );
});
