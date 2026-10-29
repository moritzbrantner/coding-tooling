import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { hotspotEvidence } from "../src/hotspots.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-hotspots-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "fixture");
  return root;
}

function commit(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
}

const lines = (count: number, tag: string) =>
  Array.from({ length: count }, (_, index) => `${tag} ${index}`).join("\n") + "\n";

describe("hotspots", () => {
  test("reports churn, large files and their intersection, excluding lock files", () => {
    const root = repository();
    for (let round = 0; round < 3; round += 1)
      commit(root, {
        "hot.ts": lines(12, `hot-${round}`),
        "busy.ts": `round ${round}\n`,
        "bun.lock": lines(50, `lock-${round}`),
      });
    commit(root, { "big.ts": lines(20, "big") });

    const result = hotspotEvidence(root, { minCommits: 3, minLines: 10 });

    expect(result.status).toBe("passed");
    expect(result.data.window.commits).toBe(4);
    expect(result.data.hotspots).toEqual([{ path: "hot.ts", commits: 3, lines: 12 }]);
    expect(result.data.churn.map((file) => file.path)).toEqual(["hot.ts", "busy.ts"]);
    expect(result.data.large.map((file) => file.path)).toEqual(["big.ts", "hot.ts"]);
  });

  test("is unavailable outside a git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-hotspots-nogit-"));
    roots.push(root);
    expect(hotspotEvidence(root).status).toBe("unavailable");
  });

  test("CLI prints a table without --json and rejects bad thresholds", () => {
    const root = repository();
    commit(root, { "a.ts": "a\n" });
    const router = resolve(import.meta.dir, "../src/router.ts");
    const table = spawnSync(process.execPath, [router, "hotspots", "--root", root], {
      encoding: "utf8",
    });
    expect(table.status).toBe(0);
    expect(table.stdout).toContain("High churn");
    const bad = spawnSync(process.execPath, [router, "hotspots", "--root", root, "--days", "0"], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(2);
  });
});
