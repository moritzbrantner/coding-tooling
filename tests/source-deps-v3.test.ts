import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { readSourceDependencyConfig, renderSourceDependencies } from "../src/source-deps.ts";

function gitRepository(root: string): string {
  mkdirSync(root, { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=main", root]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.name", "Test"]).status).toBe(0);
  mkdirSync(join(root, "crates", "a"), { recursive: true });
  mkdirSync(join(root, "crates", "b"), { recursive: true });
  writeFileSync(join(root, "README.md"), "source\n");
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "commit", "-m", "source"]).status).toBe(0);
  return spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function tomlPath(path: string): string {
  return path.replaceAll("\\", "\\\\");
}

test("schema v3 pins one revision per source repository", () => {
  const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-source-v3-"));
  const consumer = join(workspace, "consumer");
  const source = join(workspace, "source");
  mkdirSync(consumer);
  const revision = gitRepository(source);
  writeFileSync(
    join(consumer, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        cargo: {
          localOnly: true,
          repositories: [
            {
              git: "https://github.com/example/source.git",
              rev: revision,
              localPath: "../source",
              packages: [
                { package: "source-b", path: "crates/b" },
                { package: "source-a", path: "crates/a" },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  const loaded = readSourceDependencyConfig(consumer);
  expect(loaded.schemaVersion).toBe(3);
  expect(loaded.repositories).toHaveLength(1);
  expect(loaded.patches.map((patch) => patch.package)).toEqual(["source-a", "source-b"]);

  const rendered = renderSourceDependencies(consumer);
  expect(rendered.schemaVersion).toBe(3);
  expect(rendered.localOnly).toBe(true);
  expect(rendered.content).toContain(tomlPath(join(source, "crates", "a")));
  expect(rendered.content).toContain(tomlPath(join(source, "crates", "b")));
});
