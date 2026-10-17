// Acceptance for #158: controlled performance history, read per repository from a data-only
// orphan branch written by `runtime-profiler score` history workflows.
//
// Independent acceptance, written before any implementation. Seam pinned here:
//
// Owner direction (issue #158, ADR 0002 "Owner decisions — minimal, active rollout"): simplest
// thing that works. No attestation, no trusted-event allowlist, no fingerprint matching or
// verification ceremony. Measurement comparison belongs to `runtime-profiler score`.
//
// 1. Contract. A scenario in `.performance/contract.json` (schemaVersion 1 or 2, unchanged) may
//    carry an optional block
//        controlled: { history: { branch: string, path: string, scenario?: string } }
//    `scenario` is the runtime-profiler `scenario_id` filter and defaults to the contract
//    scenario's own `id`. `performanceContractValidationError` (src/performance-contract.ts) must
//    fail closed with a path-qualified ContractError message (containing
//    `scenarios[<index>].controlled`) for: a non-object `controlled` or `history`, a missing,
//    non-string or empty `branch` or `path`, an absolute `path`, a `path` with a `..` segment, and
//    a non-string `scenario`. Contracts without `controlled` validate exactly as before.
// 2. CLI. `coding-tooling performance history [--root <dir>] [--json]` prints the shared
//    `ResultEnvelope` (`schemaVersion: 1`) with `operation: "performance-history"` and
//    `data.scenarios[]` in contract order, one per scenario that declares `controlled`:
//        { id, branch, path, status: "available" | "unavailable", reason?, entries, latest? }
//    The history document is read from git objects only (never the working tree), trying
//    `refs/remotes/origin/<branch>` first and then `refs/heads/<branch>`. It must be
//    `schema_version: "runtime-profiler/score-history/v1"`. `entries` counts entries whose
//    `scenario_id` equals the filter. `latest` is the newest matching entry by `timestamp`:
//        { commit, parentCommit, timestamp, classification, score, rating,
//          averageChangePercent, reason? }
//    `classification` is "comparable" for `status: "scored"` and "incomparable" for any other
//    status (then carrying the entry's `reason`). A scenario is "unavailable" with a non-empty
//    `reason` when the branch is missing, the file is missing on the branch, the schema_version
//    is unknown, the JSON is malformed, or no entry matches the filter.
//    Status / exit: `passed` (0) when every controlled scenario is available; `unavailable` (2)
//    when any is unavailable; `failed` (1) only for a missing or invalid contract.
//    A regression (score < 100) is informational and never fails: historical ratchets are not
//    gates. Optional runner metadata in an entry is tolerated and never required.
// 3. No fingerprint check. coding-tooling does not compare `environment_fingerprint`,
//    `scenario_digest` or `workload_digest`; an entry is classified only by its own `status`.
//
// The real-shape fixture `tests/fixtures/performance-history/runtime-profiler-score-history.json`
// is a trimmed copy of runtime-profiler `origin/score-history:history.json` (at 2901a2f): three
// real entries, metrics trimmed to `process.wall_time` (stored `average_change_percent` values are
// left as recorded, so they no longer equal the trimmed metric averages).
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { performanceContractValidationError } from "../src/performance-contract.ts";

type Latest = {
  commit: string;
  parentCommit: string | null;
  timestamp: string;
  classification: "comparable" | "incomparable";
  score: number | null;
  rating: string | null;
  averageChangePercent: number | null;
  reason?: string | null;
} & Record<string, unknown>;
type HistoryScenario = {
  id: string;
  branch: string;
  path: string;
  status: "available" | "unavailable";
  reason?: string;
  entries: number;
  latest?: Latest;
} & Record<string, unknown>;
type HistoryEnvelope = {
  schemaVersion: 1;
  operation: string;
  status: "passed" | "failed" | "unavailable" | "error";
  data: { scenarios: HistoryScenario[] } & Record<string, unknown>;
  diagnostics: { code?: string; message: string }[];
};

const router = resolve(import.meta.dir, "../src/router.ts");
const realFixture = resolve(
  import.meta.dir,
  "fixtures/performance-history/runtime-profiler-score-history.json",
);
const SCHEMA = "runtime-profiler/score-history/v1";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `coding-tooling-history-${label}-`));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(root: string): void {
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
}

function write(root: string, path: string, content: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(
    join(root, path),
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

/**
 * Store `files` as one commit of a data-only history branch and point `ref` in `root` at it.
 * Built in a separate scratch repository and fetched, so `root`'s working tree never sees it.
 */
function publishBranch(root: string, ref: string, files: Record<string, unknown>): void {
  const scratch = tempDir("branch");
  initRepo(scratch);
  for (const [path, content] of Object.entries(files)) write(scratch, path, content);
  git(scratch, "add", "-A");
  git(scratch, "commit", "--quiet", "-m", "history");
  git(root, "fetch", "--quiet", scratch, `+main:${ref}`);
}
const remote = (branch: string) => `refs/remotes/origin/${branch}`;
const local = (branch: string) => `refs/heads/${branch}`;

function metricScenario(id: string, controlled?: unknown) {
  return {
    id,
    kind: "common",
    description: `Representative scenario ${id}`,
    dimensions: {},
    metrics: [
      {
        name: "wall_time",
        unit: "ms",
        direction: "lower",
        signal: "wall-clock",
        blocking: false,
      },
    ],
    ...(controlled === undefined ? {} : { controlled }),
  };
}

function contract(scenarios: unknown[], schemaVersion: 1 | 2 = 2) {
  return { schemaVersion, suite: "fixture/history", scenarios };
}

function history(entries: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA,
    repository: "fixture/repo",
    semantics: "parent-relative-retention",
    score_schema_version: "runtime-profiler/score/v1",
    retention: 1000,
    entries,
    ...extra,
  };
}

const sha = (seed: string) => seed.repeat(40).slice(0, 40);
function scored(seed: string, timestamp: string, scenario: string, extra = {}) {
  return {
    commit: sha(seed),
    parent_commit: sha(`p${seed}`),
    timestamp,
    status: "scored",
    score: 100,
    rating: "good",
    average_change_percent: -0.5,
    scenario_id: scenario,
    scenario_digest: "a".repeat(64),
    environment_fingerprint_schema_version: "runtime-profiler/environment-fingerprint/v1",
    environment_fingerprint: "e".repeat(64),
    workload_digest: `sha256:${"d".repeat(64)}`,
    metrics: [],
    excluded_metrics: [],
    reason: null,
    ...extra,
  };
}

/** A git repository with a contract on main's working tree. */
function repo(declared: unknown): string {
  const root = tempDir("repo");
  initRepo(root);
  write(root, ".performance/contract.json", declared);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "contract");
  return root;
}

function run(root: string) {
  const result = spawnSync(
    process.execPath,
    [router, "performance", "history", "--root", root, "--json"],
    { encoding: "utf8" },
  );
  let report: HistoryEnvelope | undefined;
  try {
    report = JSON.parse(result.stdout) as HistoryEnvelope;
  } catch {
    report = undefined;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

function scenarioOf(report: HistoryEnvelope | undefined, id: string): HistoryScenario {
  const found = report?.data.scenarios.find((value) => value.id === id);
  if (!found) throw new Error(`scenario ${id} missing from report: ${JSON.stringify(report)}`);
  return found;
}

const controlledBlock = (block: Record<string, unknown>) => ({ history: block });
const BRANCH = "score-history";
const PATH = "history.json";

const withControlled = (controlled: unknown, schemaVersion: 1 | 2 = 2) =>
  contract([metricScenario("example-command", controlled)], schemaVersion);

function single(entries: unknown[]) {
  const root = repo(
    contract([metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH }))]),
  );
  publishBranch(root, remote(BRANCH), { [PATH]: history(entries) });
  return run(root);
}

function unavailable(setup: (root: string) => void) {
  const root = repo(
    contract([metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH }))]),
  );
  setup(root);
  const result = run(root);
  expect(result.code).toBe(2);
  expect(result.report?.status).toBe("unavailable");
  const scenario = scenarioOf(result.report, "example-command");
  expect(scenario).toMatchObject({ branch: BRANCH, path: PATH, status: "unavailable" });
  expect(scenario.reason).toBeString();
  expect(scenario.reason?.trim().length).toBeGreaterThan(0);
  expect(scenario.latest).toBeUndefined();
  return scenario;
}

describe("contract: optional controlled block", () => {
  test("a valid controlled block is accepted on schemaVersion 1 and 2", () => {
    for (const schemaVersion of [1, 2] as const) {
      expect(
        performanceContractValidationError(
          withControlled(controlledBlock({ branch: BRANCH, path: PATH }), schemaVersion),
        ),
      ).toBeUndefined();
      expect(
        performanceContractValidationError(
          withControlled(
            controlledBlock({ branch: BRANCH, path: "data/nested/history.json", scenario: "x-y" }),
            schemaVersion,
          ),
        ),
      ).toBeUndefined();
    }
  });

  const invalid: [string, unknown][] = [
    ["controlled is a string", "score-history"],
    ["controlled is null", null],
    ["controlled is an array", [{ history: { branch: BRANCH, path: PATH } }]],
    ["history is missing", {}],
    ["history is not an object", { history: "score-history" }],
    ["branch is missing", controlledBlock({ path: PATH })],
    ["branch is empty", controlledBlock({ branch: "", path: PATH })],
    ["branch is blank", controlledBlock({ branch: "   ", path: PATH })],
    ["branch is not a string", controlledBlock({ branch: 7, path: PATH })],
    ["path is missing", controlledBlock({ branch: BRANCH })],
    ["path is empty", controlledBlock({ branch: BRANCH, path: "" })],
    ["path is absolute", controlledBlock({ branch: BRANCH, path: "/etc/history.json" })],
    ["path is parent", controlledBlock({ branch: BRANCH, path: "../history.json" })],
    ["path escapes midway", controlledBlock({ branch: BRANCH, path: "data/../../history.json" })],
    ["path is ..", controlledBlock({ branch: BRANCH, path: ".." })],
    ["scenario is not a string", controlledBlock({ branch: BRANCH, path: PATH, scenario: 42 })],
  ];
  for (const [name, controlled] of invalid)
    test(`fails closed when ${name}`, () => {
      const message = performanceContractValidationError(withControlled(controlled));
      expect(message).toBeString();
      expect(message).toContain("scenarios[0].controlled");
    });

  test("the failing scenario index is named", () => {
    const message = performanceContractValidationError(
      contract([
        metricScenario("first"),
        metricScenario("second", controlledBlock({ branch: BRANCH, path: "/abs" })),
      ]),
    );
    expect(message).toContain("scenarios[1].controlled");
  });

  test("contracts without controlled are unchanged", () => {
    expect(performanceContractValidationError(contract([metricScenario("a")], 1))).toBeUndefined();
    expect(performanceContractValidationError(contract([metricScenario("a")], 2))).toBeUndefined();
    // Pre-existing failures still fail with their pre-existing messages.
    expect(performanceContractValidationError({ ...contract([]), scenarios: [] })).toBe(
      "scenarios must be a non-empty array",
    );
    expect(
      performanceContractValidationError(contract([{ ...metricScenario("a"), kind: "nope" }])),
    ).toBe("scenarios[0].kind is not supported");
  });
});

describe("performance history: reading the orphan branch", () => {
  test("reads the remote-tracking ref, preferring it over the local branch", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([scored("1", "2026-10-01T10:00:00+02:00", "example-command")]),
    });
    publishBranch(root, local(BRANCH), {
      [PATH]: history([
        scored("2", "2026-10-02T10:00:00+02:00", "example-command"),
        scored("3", "2026-10-03T10:00:00+02:00", "example-command"),
      ]),
    });

    const { code, report } = run(root);
    expect(code).toBe(0);
    expect(report?.schemaVersion).toBe(1);
    expect(report?.operation).toBe("performance-history");
    expect(report?.status).toBe("passed");
    const scenario = scenarioOf(report, "example-command");
    expect(scenario).toMatchObject({
      id: "example-command",
      branch: BRANCH,
      path: PATH,
      status: "available",
      entries: 1,
    });
    expect(scenario.latest?.commit).toBe(sha("1"));
  });

  test("falls back to the local branch when there is no remote-tracking ref", () => {
    const root = repo(
      contract([
        metricScenario(
          "example-command",
          controlledBlock({ branch: BRANCH, path: "data/history.json" }),
        ),
      ]),
    );
    publishBranch(root, local(BRANCH), {
      "data/history.json": history([scored("2", "2026-10-02T10:00:00+02:00", "example-command")]),
    });

    const { code, report } = run(root);
    expect(code).toBe(0);
    const scenario = scenarioOf(report, "example-command");
    expect(scenario).toMatchObject({ status: "available", entries: 1, path: "data/history.json" });
    expect(scenario.latest?.commit).toBe(sha("2"));
  });

  test("ignores working-tree edits and untracked copies of the history file", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([scored("1", "2026-10-01T10:00:00+02:00", "example-command")]),
    });
    // A working-tree file at the same path with different (newer, regressing) content.
    write(
      root,
      PATH,
      history([
        scored("9", "2026-12-31T10:00:00+02:00", "example-command", { score: 1, rating: "poor" }),
      ]),
    );

    const { code, report } = run(root);
    expect(code).toBe(0);
    const scenario = scenarioOf(report, "example-command");
    expect(scenario.entries).toBe(1);
    expect(scenario.latest).toMatchObject({ commit: sha("1"), score: 100 });
  });

  test("a history file present only in the working tree is not history", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH })),
      ]),
    );
    write(root, PATH, history([scored("1", "2026-10-01T10:00:00+02:00", "example-command")]));

    const { code, report } = run(root);
    expect(code).toBe(2);
    expect(report?.status).toBe("unavailable");
    expect(scenarioOf(report, "example-command").status).toBe("unavailable");
  });
});

describe("performance history: filtering and latest entry", () => {
  test("the scenario filter defaults to the contract scenario id", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([
        scored("1", "2026-10-01T10:00:00+02:00", "example-command"),
        scored("2", "2026-10-05T10:00:00+02:00", "other-scenario"),
        scored("3", "2026-10-02T10:00:00+02:00", "example-command"),
      ]),
    });

    const scenario = scenarioOf(run(root).report, "example-command");
    expect(scenario.entries).toBe(2);
    expect(scenario.latest?.commit).toBe(sha("3"));
  });

  test("an explicit scenario filter selects runtime-profiler scenario_id", () => {
    const root = repo(
      contract([
        metricScenario(
          "example-command",
          controlledBlock({ branch: BRANCH, path: PATH, scenario: "other-scenario" }),
        ),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([
        scored("1", "2026-10-01T10:00:00+02:00", "example-command"),
        scored("2", "2026-10-05T10:00:00+02:00", "other-scenario"),
      ]),
    });

    const scenario = scenarioOf(run(root).report, "example-command");
    expect(scenario).toMatchObject({ status: "available", entries: 1 });
    expect(scenario.latest?.commit).toBe(sha("2"));
  });

  test("latest is the newest matching entry by timestamp, not by array position", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([
        scored("2", "2026-10-09T08:00:00+02:00", "example-command", {
          average_change_percent: 1.25,
        }),
        scored("1", "2026-10-01T10:00:00+02:00", "example-command"),
        scored("3", "2026-10-03T10:00:00+02:00", "example-command"),
      ]),
    });

    const scenario = scenarioOf(run(root).report, "example-command");
    expect(scenario.entries).toBe(3);
    expect(scenario.latest).toMatchObject({
      commit: sha("2"),
      parentCommit: sha("p2"),
      timestamp: "2026-10-09T08:00:00+02:00",
      classification: "comparable",
      score: 100,
      rating: "good",
      averageChangePercent: 1.25,
    });
  });
});

describe("performance history: classification", () => {
  test("a scored entry is comparable", () => {
    const { code, report } = single([scored("1", "2026-10-01T10:00:00+02:00", "example-command")]);
    expect(code).toBe(0);
    expect(scenarioOf(report, "example-command").latest?.classification).toBe("comparable");
  });

  test("a non-scored entry is incomparable, carries its reason and still passes", () => {
    const { code, report } = single([
      scored("1", "2026-10-01T10:00:00+02:00", "example-command"),
      scored("2", "2026-10-02T10:00:00+02:00", "example-command", {
        status: "unavailable",
        score: null,
        rating: "unavailable",
        average_change_percent: null,
        metrics: [],
        reason: "environment fingerprints differ; runtime comparison was unavailable",
      }),
    ]);
    expect(code).toBe(0);
    expect(report?.status).toBe("passed");
    const scenario = scenarioOf(report, "example-command");
    expect(scenario).toMatchObject({ status: "available", entries: 2 });
    expect(scenario.latest).toMatchObject({
      commit: sha("2"),
      classification: "incomparable",
      score: null,
      reason: "environment fingerprints differ; runtime comparison was unavailable",
    });
  });

  test("any status other than scored is incomparable", () => {
    const { report } = single([
      scored("1", "2026-10-01T10:00:00+02:00", "example-command", {
        status: "insufficient-samples",
        reason: "too few samples",
      }),
    ]);
    expect(scenarioOf(report, "example-command").latest).toMatchObject({
      classification: "incomparable",
      reason: "too few samples",
    });
  });

  test("a regression (score < 100) is informational and never fails", () => {
    const { code, report } = single([
      scored("1", "2026-10-01T10:00:00+02:00", "example-command", {
        score: 61,
        rating: "poor",
        average_change_percent: 38.4,
      }),
    ]);
    expect(code).toBe(0);
    expect(report?.status).toBe("passed");
    expect(scenarioOf(report, "example-command").latest).toMatchObject({
      classification: "comparable",
      score: 61,
      rating: "poor",
      averageChangePercent: 38.4,
    });
  });

  test("fingerprints and digests are not compared: only the entry's own status classifies it", () => {
    const { code, report } = single([
      scored("1", "2026-10-01T10:00:00+02:00", "example-command", {
        environment_fingerprint: "1".repeat(64),
        scenario_digest: "2".repeat(64),
        workload_digest: `sha256:${"3".repeat(64)}`,
      }),
      scored("2", "2026-10-02T10:00:00+02:00", "example-command", {
        environment_fingerprint: "4".repeat(64),
        scenario_digest: "5".repeat(64),
        workload_digest: `sha256:${"6".repeat(64)}`,
      }),
      // No fingerprint at all is fine too.
      scored("3", "2026-10-03T10:00:00+02:00", "example-command", {
        environment_fingerprint: null,
        environment_fingerprint_schema_version: null,
      }),
    ]);
    expect(code).toBe(0);
    const scenario = scenarioOf(report, "example-command");
    expect(scenario).toMatchObject({ status: "available", entries: 3 });
    expect(scenario.latest).toMatchObject({ commit: sha("3"), classification: "comparable" });
  });

  test("optional runner metadata is tolerated and never required", () => {
    const { code, report } = single([
      scored("1", "2026-10-01T10:00:00+02:00", "example-command", {
        runner: { name: "controlled-1", os: "linux", label: "self-hosted" },
        run: { id: 123, url: "https://example.invalid/runs/123" },
      }),
    ]);
    expect(code).toBe(0);
    expect(scenarioOf(report, "example-command").latest?.classification).toBe("comparable");
  });
});

describe("performance history: unavailable reasons", () => {
  test("the history branch is missing", () => {
    const scenario = unavailable(() => {});
    expect(scenario.reason).toMatch(/branch|ref/i);
    expect(scenario.entries).toBe(0);
  });

  test("the history file is missing on the branch", () => {
    const scenario = unavailable((root) =>
      publishBranch(root, remote(BRANCH), { "other.json": history([]) }),
    );
    expect(scenario.reason).toMatch(/history\.json|path|file|missing|not found/i);
  });

  test("the schema_version is unknown", () => {
    const scenario = unavailable((root) =>
      publishBranch(root, remote(BRANCH), {
        [PATH]: history([scored("1", "2026-10-01T10:00:00+02:00", "example-command")], {
          schema_version: "runtime-profiler/score-history/v99",
        }),
      }),
    );
    expect(scenario.reason).toMatch(/schema/i);
  });

  test("the JSON is malformed", () => {
    const scenario = unavailable((root) =>
      publishBranch(root, remote(BRANCH), { [PATH]: '{ "schema_version": "runtime-profiler/' }),
    );
    expect(scenario.reason).toMatch(/json|malformed|parse|invalid/i);
  });

  test("no entry matches the scenario filter", () => {
    const scenario = unavailable((root) =>
      publishBranch(root, remote(BRANCH), {
        [PATH]: history([scored("1", "2026-10-01T10:00:00+02:00", "some-other-scenario")]),
      }),
    );
    expect(scenario.entries).toBe(0);
  });

  test("one unavailable scenario makes the run unavailable while others stay reported", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: PATH })),
        metricScenario("plain-scenario"),
        metricScenario("missing-history", controlledBlock({ branch: "absent-branch", path: PATH })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([scored("1", "2026-10-01T10:00:00+02:00", "example-command")]),
    });

    const { code, report } = run(root);
    expect(code).toBe(2);
    expect(report?.status).toBe("unavailable");
    // Only scenarios with `controlled` are reported, in contract order.
    expect(report?.data.scenarios.map((value) => [value.id, value.status])).toEqual([
      ["example-command", "available"],
      ["missing-history", "unavailable"],
    ]);
  });
});

describe("performance history: failures and determinism", () => {
  test("a missing contract fails with exit 1", () => {
    const root = tempDir("empty");
    initRepo(root);
    const { code, report } = run(root);
    expect(code).toBe(1);
    expect(report?.operation).toBe("performance-history");
    expect(report?.status).toBe("failed");
  });

  test("an invalid controlled block fails with exit 1 and names the problem", () => {
    const root = repo(
      contract([
        metricScenario("example-command", controlledBlock({ branch: BRANCH, path: "../escape" })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([scored("1", "2026-10-01T10:00:00+02:00", "example-command")]),
    });
    const { code, report } = run(root);
    expect(code).toBe(1);
    expect(report?.status).toBe("failed");
    expect(JSON.stringify(report?.diagnostics)).toContain("scenarios[0].controlled");
  });

  test("malformed contract JSON fails with exit 1", () => {
    const root = repo("{ not json");
    const { code, report } = run(root);
    expect(code).toBe(1);
    expect(report?.status).toBe("failed");
  });

  test("output is deterministic across runs", () => {
    const root = repo(
      contract([
        metricScenario("zeta", controlledBlock({ branch: BRANCH, path: PATH })),
        metricScenario("alpha", controlledBlock({ branch: BRANCH, path: PATH })),
      ]),
    );
    publishBranch(root, remote(BRANCH), {
      [PATH]: history([
        scored("1", "2026-10-01T10:00:00+02:00", "zeta"),
        scored("2", "2026-10-02T10:00:00+02:00", "alpha"),
      ]),
    });
    const first = run(root);
    const second = run(root);
    expect(first.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(first.report?.data.scenarios.map((value) => value.id)).toEqual(["zeta", "alpha"]);
  });
});

describe("performance history: real runtime-profiler score-history shape", () => {
  test("a trimmed copy of the real history.json is read and classified", () => {
    const real = JSON.parse(readFileSync(realFixture, "utf8")) as {
      schema_version: string;
      entries: { commit: string; scenario_id: string }[];
    };
    expect(real.schema_version).toBe(SCHEMA);

    const root = repo(
      contract([
        metricScenario(
          "example-command",
          controlledBlock({
            branch: BRANCH,
            path: PATH,
            scenario: "runtime-profiler-history-self-score-v1",
          }),
        ),
      ]),
    );
    publishBranch(root, remote(BRANCH), { [PATH]: readFileSync(realFixture, "utf8") });

    const { code, report } = run(root);
    expect(code).toBe(0);
    expect(report?.status).toBe("passed");
    const scenario = scenarioOf(report, "example-command");
    // The first real entry belongs to the retired `runtime-profiler-history-score` cohort.
    expect(scenario).toMatchObject({ status: "available", entries: 2 });
    expect(scenario.latest).toMatchObject({
      commit: "f0638c1ad1c59c62d96863891d39481f6bd03f4d",
      parentCommit: "5e09dcb8adb75ca95b6509f3ebc3ed18e4e9fd43",
      timestamp: "2026-10-13T21:57:44+02:00",
      classification: "comparable",
      score: 100,
      rating: "good",
      averageChangePercent: 4.256,
    });
  });
});
