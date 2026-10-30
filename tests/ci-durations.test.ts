import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ciDurations, formatCiDurations, type GitHubApi } from "../src/ci-durations.ts";

// Trimmed `gh api` responses recorded from moenarch-games/mmorpg on 2026-10-30.
const recorded = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../fixtures/ci-durations/mmorpg-validate.json"), "utf8"),
) as Record<string, unknown>;

function fixtureApi(responses: Record<string, unknown>): GitHubApi {
  return (path) => {
    if (!(path in responses)) throw new Error(`HTTP 404: ${path}`);
    return responses[path];
  };
}

const job = (name: string, created: string, started: string, completed: string) => ({
  name,
  conclusion: "success",
  created_at: `2026-10-30T10:${created}Z`,
  started_at: `2026-10-30T10:${started}Z`,
  completed_at: `2026-10-30T10:${completed}Z`,
  steps: [],
});

describe("ci durations", () => {
  test("summarizes recorded default-branch runs", () => {
    const result = ciDurations("/", {
      repo: "moenarch-games/mmorpg",
      runs: 5,
      api: fixtureApi(recorded),
    });

    expect(result.status).toBe("passed");
    expect(result.data.branch).toBe("main");
    expect(result.data.workflows).toHaveLength(1);
    const validate = result.data.workflows[0]!;
    expect(validate.runs).toBe(5);
    expect(validate.wallSeconds).toEqual({ median: 26, p90: 715, max: 715 });
    expect(validate.queueSeconds.median).toBe(6);
    expect(validate.criticalPath).toEqual({
      jobs: ["scope", "rust / validate", "validation-summary"],
      runs: 5,
    });
    // Skipped jobs (clippy, pages-validation) are excluded.
    expect(validate.jobs.map((entry) => entry.name)).toEqual([
      "rust / validate",
      "scope",
      "validation-summary",
    ]);
    expect(validate.steps[0]).toMatchObject({ job: "rust / validate", step: "Test" });
    expect(validate.steps[0]!.seconds.max).toBe(544);

    const table = formatCiDurations(result.data);
    expect(table).toContain("Validate (.github/workflows/validate.yml): 5 runs");
    expect(table).toContain(
      "critical path (5/5 runs): scope > rust / validate > validation-summary",
    );
    expect(table).toContain("11m55s");
  });

  test("filters by workflow file name and follows the longer parallel branch", () => {
    const result = ciDurations("/", {
      repo: "owner/repo",
      branch: "trunk",
      workflow: "ci.yml",
      api: fixtureApi({
        "repos/owner/repo/actions/workflows?per_page=100": {
          workflows: [
            { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
            { id: 2, name: "Other", path: ".github/workflows/other.yml", state: "active" },
          ],
        },
        "repos/owner/repo/actions/workflows/1/runs?status=success&per_page=10&branch=trunk": {
          workflow_runs: [{ id: 9, run_started_at: "", updated_at: "" }],
        },
        "repos/owner/repo/actions/runs/9/jobs?per_page=100": {
          jobs: [
            job("setup", "00:00", "00:10", "01:00"),
            job("lint", "01:00", "01:05", "01:30"),
            job("browser", "01:00", "01:30", "09:00"),
            job("summary", "09:00", "09:02", "09:10"),
          ],
        },
      }),
    });

    expect(result.status).toBe("passed");
    const ci = result.data.workflows[0]!;
    expect(result.data.workflows).toHaveLength(1);
    expect(ci.criticalPath.jobs).toEqual(["setup", "browser", "summary"]);
    expect(ci.wallSeconds.median).toBe(550);
    expect(ci.queueSeconds.median).toBe(10 + 5 + 30 + 2);
    expect(ci.jobs[0]!.name).toBe("browser");
  });

  test("is unavailable when gh fails", () => {
    const result = ciDurations("/", { repo: "owner/missing", api: fixtureApi({}) });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics[0]!.code).toBe("ci-durations-gh-unavailable");
  });

  test("CLI rejects bad flags", () => {
    const router = resolve(import.meta.dir, "../src/router.ts");
    for (const args of [
      ["--runs", "0"],
      ["--repo", "not a repo"],
      ["--branch", "main", "--any-branch"],
      ["--surprise"],
    ]) {
      const bad = spawnSync(process.execPath, [router, "ci", "durations", ...args], {
        encoding: "utf8",
      });
      expect(bad.status).toBe(2);
    }
  });
});
