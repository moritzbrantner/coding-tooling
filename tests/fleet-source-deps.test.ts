import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { reconcileFleetSourceDependencies } from "../src/fleet-source-deps.ts";

function initialize(root: string): void {
  mkdirSync(root, { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=main", root]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.name", "Test"]).status).toBe(0);
}

function commit(root: string): string {
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "commit", "-m", "fixture"]).status).toBe(0);
  return spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

test("reconciles legacy package pins into an idempotent schema-v3 repository pin", () => {
  const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-fleet-source-"));
  const source = join(workspace, "source");
  const consumer = join(workspace, "consumer");
  initialize(source);
  initialize(consumer);
  mkdirSync(join(source, "crates", "a"), { recursive: true });
  writeFileSync(join(source, "README.md"), "source\n");
  const revision = commit(source);
  writeFileSync(
    join(consumer, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        cargo: {
          localOnly: true,
          patches: [
            {
              package: "source-a",
              git: "https://github.com/example/source.git",
              rev: revision,
              localPath: "../source/crates/a",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  const plan = reconcileFleetSourceDependencies(workspace);
  expect(plan.diagnostics).toEqual([]);
  expect(plan.status).toBe("passed");
  const repositories = plan.data.repositories as Array<Record<string, unknown>>;
  expect(repositories.find((repository) => repository.id === "consumer")?.migrationAvailable).toBe(
    true,
  );

  const applied = reconcileFleetSourceDependencies(workspace, { apply: true });
  expect(applied.diagnostics).toEqual([]);
  expect(applied.status).toBe("passed");
  expect(applied.data.changed).toBe(true);
  const migrated = JSON.parse(
    readFileSync(join(consumer, ".coding-tooling.source-deps.json"), "utf8"),
  );
  expect(migrated.schemaVersion).toBe(3);
  expect(migrated.cargo.repositories[0].rev).toBe(revision);
  expect(migrated.cargo.repositories[0].packages).toEqual([
    { package: "source-a", path: "crates/a" },
  ]);

  const repeated = reconcileFleetSourceDependencies(workspace, { apply: true });
  expect(repeated.diagnostics).toEqual([]);
  expect(repeated.status).toBe("passed");
  expect(repeated.data.changed).toBe(false);
});
