// Acceptance for #302: declarative latency deadlines as operation acceptance contracts.
//
// Independent acceptance, written before any implementation. Owner decisions (issue #302 and the
// ADR 0002 addendum "Owner decisions — latency/deadline acceptance") are binding: an optional
// `latency` block on an existing v2 operation (schema version unchanged); timing is read from the
// latest runtime-profiler score-history entry (or a score file) for the bound scenario, and
// coding-tooling never judges the environment (no fingerprint, runner or security checks); a
// `maxMs` miss fails `latency_deadline` everywhere; ratchets are informational unless opted in.
// Frame pacing is out of this slice and not tested.
//
// Seam pinned here:
//
// 1. Contract (`performanceContractValidationError`, src/performance-contract.ts).
//    `operations[].latency = { scenario, metric, statistic, maxMs, ratchet? }` where
//      - `scenario` names a contract scenario that declares `controlled.history`;
//      - `metric` (runtime-profiler metric id, e.g. `process.wall_time`) and `statistic`
//        (e.g. `median`, `p95`, `mean`) are non-empty strings;
//      - `maxMs` is a finite number > 0;
//      - `ratchet` is optional, `"informational"` (default) or `"blocking"`.
//    Validation fails closed with a message containing `operations[<i>].latency` for an unknown
//    scenario, a scenario without `controlled`, a non-positive / non-finite / non-number `maxMs`,
//    missing or empty strings, an unknown `ratchet` value, and an unknown field.
//    Smallest relaxation: an operation that carries `latency` may omit `metrics`; an operation
//    with neither still fails. Fixtures here always keep `dimensions` and `scalePoints` (whether
//    they also become optional for latency-only operations is not pinned). Contracts without
//    `latency` validate exactly as before. The published schema lists `latency` on operations.
//
// 2. CLI. `coding-tooling performance acceptance [--root <dir>] [--evidence <work evidence>]
//    [--score <runtime-profiler score json>] [--json]` prints the shared ResultEnvelope
//    (`schemaVersion: 1`, `operation: "performance-acceptance"`) with
//    `data.schemaVersion: "coding-tooling/performance-acceptance/v1"` and `data.operations[]` in
//    contract order: `{ id, verdicts: { functional, work_growth, absolute_work, latency_deadline,
//    historical_ratchet } }`; each verdict has `state: "passed" | "failed" | "unavailable" |
//    "not-declared" | "informational"`, and an `unavailable` verdict carries a non-empty `reason`.
//    - `latency_deadline`: from the newest (by timestamp) score-history entry whose `scenario_id`
//      matches the bound scenario's history filter — or, with `--score`, from that
//      `runtime-profiler/score/v1` document, whose `scenario_id` must match the filter — take
//      `metrics[id == metric].statistics[statistic == statistic].candidate`. The metric's `unit`
//      must be `"ms"`; any other or missing unit is `unavailable`. value <= maxMs is `passed`,
//      value > maxMs is `failed`; both carry `{ value, maxMs, metric, statistic, source }` where
//      `source.kind` is `"history"` (with the entry's `commit`) or `"score"`. A missing branch,
//      file, matching entry, metric, statistic, candidate or unit is `unavailable`, never passed.
//      Only the newest entry counts: there is no fallback to an older entry.
//      No `latency` block: `not-declared`.
//    - `historical_ratchet`: from the same statistic's `change_percent` / `score` (runtime-profiler
//      convention: negative change_percent and score < 100 are regressions; fixtures keep both
//      signals consistent, so either is a valid rule). Carries `changePercent` and
//      `regression: boolean`. `informational` unless `ratchet: "blocking"`, then `failed` on a
//      regression and `passed` otherwise. Never `passed` when the timing source is unavailable.
//      No `latency` block: `not-declared`.
//    - `work_growth` / `absolute_work`: the existing `performance work` checks, `kind: "growth"`
//      and `kind: "budget"` respectively, evaluated from `--evidence`. `not-declared` when the
//      operation declares no check of that kind; `unavailable` when declared but no usable evidence.
//    - `functional`: operations declare no correctness evidence today, so it is `not-declared`;
//      nothing is executed.
//    Status / exit: `failed` (1) when any authoritative verdict failed (functional, work_growth,
//    absolute_work, latency_deadline, and historical_ratchet only when blocking); otherwise
//    `unavailable` (2) when any verdict is unavailable; otherwise `passed` (0). `not-declared` and
//    `informational` never affect the status. A missing or invalid contract never passes.
//
// The pilot fixture `tests/fixtures/performance-acceptance/runtime-profiler-score-history.json` is
// a trimmed copy of runtime-profiler `origin/score-history:history.json` (at 54c0075): the last two
// `runtime-profiler-history-self-score-v1` entries, metrics trimmed to `process.wall_time` and
// `process.success_rate`. The newest (e7829dd) records `unit` and absolute `reference`/`candidate`
// values; p95 candidate 5.200082 ms under the declared pilot ceiling `maxMs: 8` passes.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { performanceContractValidationError } from "../src/performance-contract.ts";

type Verdict = {
  state: "passed" | "failed" | "unavailable" | "not-declared" | "informational";
  reason?: string;
  value?: number;
  maxMs?: number;
  metric?: string;
  statistic?: string;
  source?: { kind?: string; commit?: string | null } & Record<string, unknown>;
  changePercent?: number | null;
  regression?: boolean;
} & Record<string, unknown>;
type VerdictName =
  | "functional"
  | "work_growth"
  | "absolute_work"
  | "latency_deadline"
  | "historical_ratchet";
type OperationReport = { id: string; verdicts: Record<VerdictName, Verdict> };
type AcceptanceEnvelope = {
  schemaVersion: 1;
  operation: string;
  status: "passed" | "failed" | "unavailable" | "error";
  data: { schemaVersion: string; operations: OperationReport[] } & Record<string, unknown>;
  diagnostics: { code?: string; message: string }[];
};

const router = resolve(import.meta.dir, "../src/router.ts");
const pilotHistory = resolve(
  import.meta.dir,
  "fixtures/performance-acceptance/runtime-profiler-score-history.json",
);
const HISTORY_SCHEMA = "runtime-profiler/score-history/v1";
const SCORE_SCHEMA = "runtime-profiler/score/v1";
const BRANCH = "score-history";
const PATH = "history.json";
const SCENARIO = "cast-fireball-timing";
const VERDICTS: VerdictName[] = [
  "functional",
  "work_growth",
  "absolute_work",
  "latency_deadline",
  "historical_ratchet",
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `coding-tooling-acceptance-${label}-`));
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

function write(root: string, path: string, content: unknown): string {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
  return absolute;
}

/** Store `files` as one commit of a data-only branch fetched into `root` as origin's `branch`. */
function publishHistory(root: string, document: unknown, branch = BRANCH): void {
  const scratch = tempDir("branch");
  initRepo(scratch);
  write(scratch, PATH, document);
  git(scratch, "add", "-A");
  git(scratch, "commit", "--quiet", "-m", "history");
  git(root, "fetch", "--quiet", scratch, `+main:refs/remotes/origin/${branch}`);
}

// ---------------------------------------------------------------------------------------------
// Contract builders

function timingScenario(
  id = SCENARIO,
  controlled: unknown = { history: { branch: BRANCH, path: PATH } },
) {
  return {
    id,
    kind: "common",
    description: `Controlled timing scenario ${id}`,
    dimensions: {},
    metrics: [
      {
        name: "process.wall_time",
        unit: "ms",
        direction: "lower",
        signal: "wall-clock",
        blocking: false,
      },
    ],
    ...(controlled === null ? {} : { controlled }),
  };
}

function latency(overrides: Record<string, unknown> = {}) {
  return {
    scenario: SCENARIO,
    metric: "process.wall_time",
    statistic: "p95",
    maxMs: 10,
    ...overrides,
  };
}

const workMetrics = [
  {
    name: "projectiles_spawned",
    unit: "projectiles",
    signal: "operation-count",
    budget: { max: 1 },
    growth: [{ dimension: "enemies", bound: "constant" }],
  },
];

/** An operation; `metrics: undefined` drops the key, `latency: undefined` drops the block. */
function op(options: { id?: string; latency?: unknown; metrics?: unknown } = {}) {
  const value: Record<string, unknown> = {
    id: options.id ?? "cast-fireball",
    description: "Cast a fireball into a dense combat encounter.",
    dimensions: { enemies: { description: "enemies on screen" } },
    scalePoints: [{ enemies: 10 }, { enemies: 100 }],
  };
  if ("metrics" in options) {
    if (options.metrics !== undefined) value.metrics = options.metrics;
  } else value.metrics = workMetrics;
  if (options.latency !== undefined) value.latency = options.latency;
  return value;
}

function contract(operations: unknown[], scenarios: unknown[] = [timingScenario()]) {
  return { schemaVersion: 2, suite: "fixture/acceptance", scenarios, operations };
}

// ---------------------------------------------------------------------------------------------
// History / score builders in the real runtime-profiler shape

const sha = (seed: string) => seed.repeat(40).slice(0, 40);

type Statistic = {
  statistic?: string;
  reference?: number;
  candidate?: number;
  change?: number | null;
  score?: number;
};

function historyMetric(stat: Statistic & { id?: string; unit?: string | null } = {}) {
  const statistic: Record<string, unknown> = {
    statistic: stat.statistic ?? "p95",
    score: stat.score ?? 100,
    change_percent: stat.change === undefined ? 0 : stat.change,
  };
  if (stat.reference !== undefined) statistic.reference = stat.reference;
  if (stat.candidate !== undefined) statistic.candidate = stat.candidate;
  const metric: Record<string, unknown> = {
    id: stat.id ?? "process.wall_time",
    score: stat.score ?? 100,
    average_change_percent: stat.change ?? 0,
    statistics: [statistic],
  };
  if (stat.unit !== null) metric.unit = stat.unit ?? "ms";
  return metric;
}

function entry(
  seed: string,
  timestamp: string,
  metrics: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    commit: sha(seed),
    parent_commit: sha(`p${seed}`),
    timestamp,
    status: "scored",
    score: 100,
    rating: "good",
    average_change_percent: 0,
    scenario_id: SCENARIO,
    scenario_digest: "a".repeat(64),
    environment_fingerprint_schema_version: "runtime-profiler/environment-fingerprint/v1",
    environment_fingerprint: "e".repeat(64),
    workload_digest: `sha256:${"d".repeat(64)}`,
    metrics,
    excluded_metrics: [],
    reason: null,
    ...extra,
  };
}

function history(entries: unknown[]) {
  return {
    schema_version: HISTORY_SCHEMA,
    repository: "fixture/repo",
    semantics: "parent-relative-retention",
    score_schema_version: SCORE_SCHEMA,
    retention: 1000,
    entries,
  };
}

/** One-entry history recording a reference -> candidate p95 cast. */
function cast(reference: number, candidate: number) {
  const change = Math.round(((reference - candidate) / reference) * 100_000) / 1000;
  const score = change < 0 ? Math.max(0, Math.round(100 + change)) : 100;
  return history([
    entry("c", "2026-10-17T10:00:00+02:00", [
      historyMetric({ reference, candidate, change, score }),
    ]),
  ]);
}

function scoreDocument(
  candidate: number,
  options: { scenario?: string; reference?: number; unit?: string } = {},
) {
  const reference = options.reference ?? candidate;
  const change = Math.round(((reference - candidate) / reference) * 100_000) / 1000;
  const score = change < 0 ? Math.max(0, Math.round(100 + change)) : 100;
  return {
    schema_version: SCORE_SCHEMA,
    scenario_id: options.scenario ?? SCENARIO,
    scenario_digest: "a".repeat(64),
    environment_fingerprint_schema_version: "runtime-profiler/environment-fingerprint/v1",
    environment_fingerprint: "e".repeat(64),
    reference_bundle_id: "reference-bundle",
    candidate_bundle_id: "candidate-bundle",
    reference_source: { git_sha: sha("r"), dirty: false },
    candidate_source: { git_sha: sha("s"), dirty: false },
    score,
    rating: score === 100 ? "good" : "poor",
    metrics: [
      {
        id: "process.wall_time",
        unit: options.unit ?? "ms",
        preferred_direction: "lower",
        score,
        statistics: [{ statistic: "p95", reference, candidate, change_percent: change, score }],
      },
    ],
    excluded_metrics: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Repository + CLI helpers

/** A git repository whose main working tree holds the contract; history optional. */
function repo(declared: unknown, historyDocument?: unknown): string {
  const root = tempDir("repo");
  initRepo(root);
  write(root, ".performance/contract.json", declared);
  write(root, "package.json", { name: "fixture", private: true });
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "contract");
  if (historyDocument !== undefined) publishHistory(root, historyDocument);
  return root;
}

function contractSha256(root: string): string {
  return createHash("sha256")
    .update(readFileSync(join(root, ".performance/contract.json")))
    .digest("hex");
}

/** Work evidence for the `cast-fireball` operation with the given counter per scale point. */
function workEvidence(root: string, values: [number, number], id = "cast-fireball"): string {
  return write(tempDir("evidence"), "evidence.json", {
    schemaVersion: "coding-tooling/work-evidence/v1",
    suite: "fixture/acceptance",
    contractSha256: contractSha256(root),
    operations: [
      {
        id,
        samples: [
          { dimensions: { enemies: 10 }, metrics: { projectiles_spawned: values[0] } },
          { dimensions: { enemies: 100 }, metrics: { projectiles_spawned: values[1] } },
        ],
      },
    ],
  });
}

function run(root: string, extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [router, "performance", "acceptance", "--root", root, ...extra, "--json"],
    { encoding: "utf8" },
  );
  let report: AcceptanceEnvelope | undefined;
  try {
    report = JSON.parse(result.stdout) as AcceptanceEnvelope;
  } catch {
    report = undefined;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

function verdictsOf(report: AcceptanceEnvelope | undefined, id = "cast-fireball") {
  const found = report?.data?.operations?.find((value) => value.id === id);
  if (!found) throw new Error(`operation ${id} missing from report: ${JSON.stringify(report)}`);
  return found.verdicts;
}

function expectUnavailable(verdict: Verdict) {
  expect(verdict.state).toBe("unavailable");
  expect(verdict.reason).toBeString();
  expect(verdict.reason!.trim().length).toBeGreaterThan(0);
}

function unavailableRun(declared: unknown, historyDocument?: unknown, extra: string[] = []) {
  const root = repo(declared, historyDocument);
  const result = run(root, extra);
  const verdicts = verdictsOf(result.report);
  expectUnavailable(verdicts.latency_deadline);
  expect(verdicts.historical_ratchet.state).not.toBe("passed");
  expect(result.report?.status).toBe("unavailable");
  expect(result.code).toBe(2);
  return verdicts;
}

function scored(declared: unknown, document: unknown, historyDocument?: unknown) {
  const root = repo(declared, historyDocument);
  const path = write(tempDir("score"), "score.json", document);
  return run(root, ["--score", path]);
}

const PILOT = "runtime-profiler-history-self-score-v1";
const realHistory = () => JSON.parse(readFileSync(pilotHistory, "utf8"));

const pilotContract = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  suite: "runtime-profiler/score-history",
  scenarios: [
    {
      id: PILOT,
      kind: "common",
      description:
        "runtime-profiler scoring its own parent-relative history workload in the score-history workflow",
      dimensions: {},
      metrics: [
        {
          name: "process.wall_time",
          unit: "ms",
          direction: "lower",
          signal: "wall-clock",
          blocking: false,
        },
      ],
      controlled: { history: { branch: BRANCH, path: PATH } },
    },
  ],
  operations: [
    {
      id: "history-self-score",
      description: "Score runtime-profiler's own parent-relative history workload.",
      dimensions: { runs: {} },
      scalePoints: [{ runs: 1 }],
      latency: {
        scenario: PILOT,
        metric: "process.wall_time",
        statistic: "p95",
        maxMs: 8,
        ...overrides,
      },
    },
  ],
});

/** A latency-only operation (no work metrics) bound to SCENARIO. */
const latencyOnly = (overrides: Record<string, unknown> = {}) =>
  contract([op({ metrics: undefined, latency: latency(overrides) })]);

// ---------------------------------------------------------------------------------------------

describe("fixture sanity against today's readers", () => {
  test("the work evidence fixture is accepted by performance work", () => {
    const root = repo(contract([op()]));
    const work = (values: [number, number]) =>
      spawnSync(
        process.execPath,
        [
          router,
          "performance",
          "work",
          "--root",
          root,
          "--evidence",
          workEvidence(root, values),
          "--json",
        ],
        { encoding: "utf8" },
      );
    expect(JSON.parse(work([1, 1]).stdout).status).toBe("passed");
    expect(JSON.parse(work([2, 2]).stdout).status).toBe("failed");
  });

  test("the synthetic and pilot histories are read by performance history", () => {
    for (const [document, commit] of [
      [cast(4, 5), sha("c")],
      [JSON.parse(readFileSync(pilotHistory, "utf8")), "e7829dd18852e71d8ab0aa14718c4d14ae28b189"],
    ] as const) {
      const scenario = commit === sha("c") ? SCENARIO : PILOT;
      const declared = {
        schemaVersion: 2,
        suite: "fixture/acceptance",
        scenarios: [timingScenario(scenario)],
      };
      const root = repo(declared, document);
      const result = spawnSync(
        process.execPath,
        [router, "performance", "history", "--root", root, "--json"],
        { encoding: "utf8" },
      );
      const report = JSON.parse(result.stdout);
      expect(report.status).toBe("passed");
      expect(report.data.scenarios[0].latest.commit).toBe(commit);
    }
  });
});

describe("contract: optional operations[].latency block", () => {
  test("a latency block on a v2 operation with work metrics is accepted", () => {
    expect(
      performanceContractValidationError(contract([op({ latency: latency() })])),
    ).toBeUndefined();
    for (const ratchet of ["informational", "blocking"])
      expect(
        performanceContractValidationError(contract([op({ latency: latency({ ratchet }) })])),
      ).toBeUndefined();
    for (const statistic of ["median", "p95", "mean"])
      expect(
        performanceContractValidationError(contract([op({ latency: latency({ statistic }) })])),
      ).toBeUndefined();
    expect(
      performanceContractValidationError(contract([op({ latency: latency({ maxMs: 7.5 }) })])),
    ).toBeUndefined();
  });

  test("an operation with latency may omit work metrics; one with neither is still rejected", () => {
    expect(performanceContractValidationError(latencyOnly())).toBeUndefined();
    expect(performanceContractValidationError(contract([op({ metrics: undefined })]))).toBeString();
  });

  test("the bound scenario's custom history filter is accepted", () => {
    const scenario = timingScenario(SCENARIO, {
      history: { branch: BRANCH, path: PATH, scenario: "runtime-scenario-v2" },
    });
    expect(
      performanceContractValidationError(contract([op({ latency: latency() })], [scenario])),
    ).toBeUndefined();
  });

  test("contracts without latency are unchanged", () => {
    expect(performanceContractValidationError(contract([op()]))).toBeUndefined();
    expect(
      performanceContractValidationError({ ...contract([]), operations: undefined }),
    ).toBeUndefined();
  });

  const invalid: [string, unknown][] = [
    ["unknown scenario", latency({ scenario: "no-such-scenario" })],
    ["empty scenario", latency({ scenario: "" })],
    ["missing metric", { scenario: SCENARIO, statistic: "p95", maxMs: 10 }],
    ["empty metric", latency({ metric: "  " })],
    ["missing statistic", { scenario: SCENARIO, metric: "process.wall_time", maxMs: 10 }],
    ["non-string statistic", latency({ statistic: 95 })],
    ["missing maxMs", { scenario: SCENARIO, metric: "process.wall_time", statistic: "p95" }],
    ["zero maxMs", latency({ maxMs: 0 })],
    ["negative maxMs", latency({ maxMs: -1 })],
    ["string maxMs", latency({ maxMs: "8" })],
    ["infinite maxMs", latency({ maxMs: Number.POSITIVE_INFINITY })],
    ["unknown ratchet", latency({ ratchet: "strict" })],
    ["unknown field", latency({ percentile: 95 })],
    ["non-object block", "p95<10ms"],
  ];
  for (const [label, block] of invalid)
    test(`fails closed for ${label}`, () => {
      const error = performanceContractValidationError(contract([op({ latency: block })]));
      expect(error).toBeString();
      expect(error).toContain("operations[0].latency");
    });

  test("fails closed when the bound scenario has no controlled block", () => {
    const declared = contract([op({ latency: latency() })], [timingScenario(SCENARIO, null)]);
    const error = performanceContractValidationError(declared);
    expect(error).toBeString();
    expect(error).toContain("operations[0].latency");
  });

  test("the published schema declares latency on operations", () => {
    const schema = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../schemas/performance-contract.schema.json"), "utf8"),
    );
    expect(schema.properties.operations.items.properties.latency).toBeDefined();
  });
});

describe("performance acceptance: issue scenarios", () => {
  test("a 4 -> 5 ms cast under a 10 ms ceiling passes with an informational ratchet regression", () => {
    const root = repo(latencyOnly(), cast(4, 5));
    const result = run(root);
    expect(result.report?.schemaVersion).toBe(1);
    expect(result.report?.operation).toBe("performance-acceptance");
    expect(result.report?.data.schemaVersion).toBe("coding-tooling/performance-acceptance/v1");
    const verdicts = verdictsOf(result.report);
    expect(new Set(Object.keys(verdicts))).toEqual(new Set(VERDICTS));
    expect(verdicts.latency_deadline).toMatchObject({
      state: "passed",
      value: 5,
      maxMs: 10,
      metric: "process.wall_time",
      statistic: "p95",
      source: { kind: "history", commit: sha("c") },
    });
    expect(verdicts.historical_ratchet).toMatchObject({
      state: "informational",
      regression: true,
      changePercent: -25,
    });
    expect(verdicts.functional.state).toBe("not-declared");
    expect(verdicts.work_growth.state).toBe("not-declared");
    expect(verdicts.absolute_work.state).toBe("not-declared");
    expect(result.report?.status).toBe("passed");
    expect(result.code).toBe(0);
  });

  test("a 12 ms cast fails a 10 ms ceiling even though it improved from 20 ms", () => {
    const root = repo(latencyOnly(), cast(20, 12));
    const result = run(root);
    const verdicts = verdictsOf(result.report);
    expect(verdicts.latency_deadline).toMatchObject({ state: "failed", value: 12, maxMs: 10 });
    expect(verdicts.historical_ratchet).toMatchObject({
      state: "informational",
      regression: false,
      changePercent: 40,
    });
    expect(result.report?.status).toBe("failed");
    expect(result.code).toBe(1);
  });

  test("a 12 ms cast fails a 10 ms ceiling even with passing O(1) work", () => {
    const root = repo(contract([op({ latency: latency() })]), cast(20, 12));
    const result = run(root, ["--evidence", workEvidence(root, [1, 1])]);
    const verdicts = verdictsOf(result.report);
    expect(verdicts.work_growth.state).toBe("passed");
    expect(verdicts.absolute_work.state).toBe("passed");
    expect(verdicts.latency_deadline.state).toBe("failed");
    expect(result.report?.status).toBe("failed");
    expect(result.code).toBe(1);
  });

  test("editing the ceiling is a visible contract change that moves the verdict deterministically", () => {
    const states = [4, 5, 5.0001, 10].map((maxMs) => {
      const root = repo(latencyOnly({ maxMs }), cast(4, 5));
      const first = run(root);
      const second = run(root);
      expect(second.report?.data).toEqual(first.report!.data);
      const verdict = verdictsOf(first.report).latency_deadline;
      expect(verdict.maxMs).toBe(maxMs);
      return [verdict.state, first.code];
    });
    expect(states).toEqual([
      ["failed", 1],
      ["passed", 0],
      ["passed", 0],
      ["passed", 0],
    ]);
  });
});

describe("performance acceptance: historical ratchet policy", () => {
  test("a blocking ratchet fails on a regression under a passing ceiling", () => {
    const root = repo(latencyOnly({ ratchet: "blocking" }), cast(4, 5));
    const result = run(root);
    const verdicts = verdictsOf(result.report);
    expect(verdicts.latency_deadline.state).toBe("passed");
    expect(verdicts.historical_ratchet).toMatchObject({ state: "failed", regression: true });
    expect(result.report?.status).toBe("failed");
    expect(result.code).toBe(1);
  });

  test("a blocking ratchet passes on an improvement", () => {
    const root = repo(latencyOnly({ ratchet: "blocking" }), cast(6, 5));
    const result = run(root);
    const verdicts = verdictsOf(result.report);
    expect(verdicts.latency_deadline.state).toBe("passed");
    expect(verdicts.historical_ratchet).toMatchObject({ state: "passed", regression: false });
    expect(result.code).toBe(0);
  });

  test("an explicit informational ratchet never fails", () => {
    const root = repo(latencyOnly({ ratchet: "informational" }), cast(2, 9));
    const result = run(root);
    expect(verdictsOf(result.report).historical_ratchet).toMatchObject({
      state: "informational",
      regression: true,
    });
    expect(result.code).toBe(0);
  });
});

describe("performance acceptance: missing or mismatched timing evidence is never green", () => {
  test("no history branch", () => {
    unavailableRun(latencyOnly());
  });

  test("a blocking ratchet without history is not passed", () => {
    const verdicts = unavailableRun(latencyOnly({ ratchet: "blocking" }));
    expect(verdicts.historical_ratchet.state).not.toBe("passed");
  });

  test("changed scenario identity: history has no entry for the bound scenario", () => {
    const renamed = history([
      entry("c", "2026-10-17T10:00:00+02:00", [historyMetric({ reference: 4, candidate: 5 })], {
        scenario_id: "cast-fireball-timing-v2",
      }),
    ]);
    unavailableRun(latencyOnly(), renamed);
  });

  test("changed scenario identity: the history filter names a scenario with no entries", () => {
    const scenario = timingScenario(SCENARIO, {
      history: { branch: BRANCH, path: PATH, scenario: "renamed-runtime-scenario" },
    });
    unavailableRun(
      contract([op({ metrics: undefined, latency: latency() })], [scenario]),
      cast(4, 5),
    );
  });

  test("a non-ms unit", () => {
    const seconds = history([
      entry("c", "2026-10-17T10:00:00+02:00", [
        historyMetric({ reference: 0.004, candidate: 0.005, unit: "s" }),
      ]),
    ]);
    unavailableRun(latencyOnly(), seconds);
  });

  test("a metric without a recorded unit", () => {
    const unitless = history([
      entry("c", "2026-10-17T10:00:00+02:00", [
        historyMetric({ reference: 4, candidate: 5, unit: null }),
      ]),
    ]);
    unavailableRun(latencyOnly(), unitless);
  });

  test("an entry without the absolute candidate value (pre-#118 shape)", () => {
    const relativeOnly = history([
      entry("c", "2026-10-17T10:00:00+02:00", [historyMetric({ change: -25, score: 75 })]),
    ]);
    unavailableRun(latencyOnly(), relativeOnly);
  });

  test("the bound metric is missing from the entry", () => {
    unavailableRun(latencyOnly({ metric: "process.cpu_time" }), cast(4, 5));
  });

  test("the bound statistic is missing from the entry", () => {
    unavailableRun(latencyOnly({ statistic: "median" }), cast(4, 5));
  });

  test("the newest entry is unscored: no fallback to an older passing entry", () => {
    const stale = history([
      entry("a", "2026-10-16T10:00:00+02:00", [historyMetric({ reference: 4, candidate: 5 })]),
      entry("b", "2026-10-17T10:00:00+02:00", [], {
        status: "unavailable",
        score: null,
        rating: null,
        average_change_percent: null,
        reason: "candidate bundle failed validation",
      }),
    ]);
    unavailableRun(latencyOnly(), stale);
  });

  test("the newest entry by timestamp decides, not the first matching entry", () => {
    const root = repo(
      latencyOnly(),
      history([
        entry("n", "2026-10-17T12:00:00+02:00", [historyMetric({ reference: 9, candidate: 12 })]),
        entry("o", "2026-10-16T12:00:00+02:00", [historyMetric({ reference: 4, candidate: 5 })]),
      ]),
    );
    const result = run(root);
    expect(verdictsOf(result.report).latency_deadline).toMatchObject({
      state: "failed",
      value: 12,
      source: { kind: "history", commit: sha("n") },
    });
    expect(result.code).toBe(1);
  });

  test("a failed authoritative verdict outranks an unavailable one", () => {
    // No history (latency unavailable) and a work budget miss (absolute_work failed).
    const root = repo(contract([op({ latency: latency() })]));
    const result = run(root, ["--evidence", workEvidence(root, [2, 2])]);
    const verdicts = verdictsOf(result.report);
    expectUnavailable(verdicts.latency_deadline);
    expect(verdicts.absolute_work.state).toBe("failed");
    expect(verdicts.work_growth.state).toBe("passed");
    expect(result.report?.status).toBe("failed");
    expect(result.code).toBe(1);
  });
});

describe("performance acceptance: --score file as the timing source", () => {
  test("a candidate under the ceiling passes from the score file", () => {
    const result = scored(latencyOnly(), scoreDocument(5, { reference: 4 }));
    const verdicts = verdictsOf(result.report);
    expect(verdicts.latency_deadline).toMatchObject({
      state: "passed",
      value: 5,
      maxMs: 10,
      source: { kind: "score" },
    });
    expect(verdicts.historical_ratchet).toMatchObject({ state: "informational", regression: true });
    expect(result.code).toBe(0);
  });

  test("the score file overrides history", () => {
    const result = scored(latencyOnly(), scoreDocument(12, { reference: 20 }), cast(4, 5));
    expect(verdictsOf(result.report).latency_deadline).toMatchObject({
      state: "failed",
      value: 12,
      source: { kind: "score" },
    });
    expect(result.code).toBe(1);
  });

  test("a score for a different scenario is unavailable", () => {
    const result = scored(latencyOnly(), scoreDocument(5, { scenario: "another-scenario" }));
    expectUnavailable(verdictsOf(result.report).latency_deadline);
    expect(result.code).toBe(2);
  });

  test("a non-ms score metric is unavailable", () => {
    const result = scored(latencyOnly(), scoreDocument(0.005, { unit: "s" }));
    expectUnavailable(verdictsOf(result.report).latency_deadline);
    expect(result.code).toBe(2);
  });

  test("a missing score file is unavailable, not passed", () => {
    const root = repo(latencyOnly(), cast(4, 5));
    const result = run(root, ["--score", join(tempDir("missing"), "score.json")]);
    expect(result.report?.operation).toBe("performance-acceptance");
    expect(result.report?.status).not.toBe("passed");
    expect(result.code).not.toBe(0);
    if (result.report?.data?.operations?.length)
      expect(verdictsOf(result.report).latency_deadline.state).not.toBe("passed");
  });
});

describe("performance acceptance: work verdicts reuse performance work checks", () => {
  test("an operation without latency reports latency and ratchet as not-declared", () => {
    const root = repo(contract([op()]));
    const result = run(root, ["--evidence", workEvidence(root, [1, 1])]);
    const verdicts = verdictsOf(result.report);
    expect(verdicts.latency_deadline.state).toBe("not-declared");
    expect(verdicts.historical_ratchet.state).toBe("not-declared");
    expect(verdicts.work_growth.state).toBe("passed");
    expect(verdicts.absolute_work.state).toBe("passed");
    expect(verdicts.functional.state).toBe("not-declared");
    expect(result.code).toBe(0);
  });

  test("growth and budget map to work_growth and absolute_work independently", () => {
    const root = repo(contract([op()]));
    // 1 -> 2 projectiles: constant growth fails, and budget max 1 fails at the larger point.
    const growth = run(root, ["--evidence", workEvidence(root, [1, 2])]);
    expect(verdictsOf(growth.report).work_growth.state).toBe("failed");
    expect(verdictsOf(growth.report).absolute_work.state).toBe("failed");
    expect(growth.code).toBe(1);
    // 2 -> 2: constant growth holds, budget max 1 fails.
    const budget = run(root, ["--evidence", workEvidence(root, [2, 2])]);
    expect(verdictsOf(budget.report).work_growth.state).toBe("passed");
    expect(verdictsOf(budget.report).absolute_work.state).toBe("failed");
    expect(budget.code).toBe(1);
  });

  test("a metric with only a growth bound leaves absolute_work not-declared", () => {
    const metrics = [{ ...workMetrics[0], budget: undefined }];
    const root = repo(contract([op({ metrics })]));
    const result = run(root, ["--evidence", workEvidence(root, [1, 1])]);
    expect(verdictsOf(result.report).work_growth.state).toBe("passed");
    expect(verdictsOf(result.report).absolute_work.state).toBe("not-declared");
    expect(result.code).toBe(0);
  });

  test("declared work without evidence is unavailable", () => {
    const root = repo(contract([op({ latency: latency() })]), cast(4, 5));
    const result = run(root);
    const verdicts = verdictsOf(result.report);
    expect(verdicts.latency_deadline.state).toBe("passed");
    expectUnavailable(verdicts.work_growth);
    expectUnavailable(verdicts.absolute_work);
    expect(result.report?.status).toBe("unavailable");
    expect(result.code).toBe(2);
  });

  test("operations are reported in contract order", () => {
    const declared = contract([
      op({ id: "zeta-cast", metrics: undefined, latency: latency() }),
      op({ id: "alpha-cast", metrics: undefined, latency: latency({ maxMs: 4 }) }),
    ]);
    const result = run(repo(declared, cast(4, 5)));
    expect(result.report?.data.operations.map((value) => value.id)).toEqual([
      "zeta-cast",
      "alpha-cast",
    ]);
    expect(verdictsOf(result.report, "zeta-cast").latency_deadline.state).toBe("passed");
    expect(verdictsOf(result.report, "alpha-cast").latency_deadline.state).toBe("failed");
    expect(result.code).toBe(1);
  });

  test("performance work still verifies an operation that also carries latency", () => {
    const root = repo(contract([op({ latency: latency() })]));
    const evidence = workEvidence(root, [1, 1]);
    const result = spawnSync(
      process.execPath,
      [router, "performance", "work", "--root", root, "--evidence", evidence, "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result.stdout).status).toBe("passed");
    expect(result.status).toBe(0);
  });
});

describe("performance acceptance: contract failures never pass", () => {
  test("a missing contract", () => {
    const root = tempDir("empty");
    initRepo(root);
    const result = run(root);
    expect(result.report?.operation).toBe("performance-acceptance");
    expect(result.report?.status).not.toBe("passed");
    expect(result.code).not.toBe(0);
  });

  test("an invalid latency block", () => {
    const root = repo(latencyOnly({ maxMs: 0 }), cast(4, 5));
    const result = run(root);
    expect(result.report?.status).not.toBe("passed");
    expect(result.code).not.toBe(0);
    expect(JSON.stringify(result.report?.diagnostics ?? null)).toContain("latency");
  });
});

describe("pilot: runtime-profiler-history-self-score-v1 p95 under maxMs 8", () => {
  test("the pilot contract is valid", () => {
    expect(performanceContractValidationError(pilotContract())).toBeUndefined();
  });

  test("the real e7829dd entry passes the declared 8 ms p95 ceiling", () => {
    const result = run(repo(pilotContract(), realHistory()));
    const verdicts = verdictsOf(result.report, "history-self-score");
    expect(verdicts.latency_deadline).toMatchObject({
      state: "passed",
      value: 5.200082,
      maxMs: 8,
      metric: "process.wall_time",
      statistic: "p95",
      source: { kind: "history", commit: "e7829dd18852e71d8ab0aa14718c4d14ae28b189" },
    });
    expect(verdicts.historical_ratchet).toMatchObject({
      state: "informational",
      regression: false,
      changePercent: 0.116,
    });
    expect(result.code).toBe(0);
  });

  test("the same real entry fails a 5 ms ceiling and reads the median statistic", () => {
    const tight = run(repo(pilotContract({ maxMs: 5 }), realHistory()));
    expect(verdictsOf(tight.report, "history-self-score").latency_deadline).toMatchObject({
      state: "failed",
      value: 5.200082,
    });
    expect(tight.code).toBe(1);
    const median = run(repo(pilotContract({ statistic: "median" }), realHistory()));
    expect(verdictsOf(median.report, "history-self-score").latency_deadline).toMatchObject({
      state: "passed",
      value: 5.186502,
    });
  });

  test("the real ratio-unit success rate cannot satisfy a millisecond ceiling", () => {
    const result = run(
      repo(pilotContract({ metric: "process.success_rate", statistic: "mean" }), realHistory()),
    );
    expectUnavailable(verdictsOf(result.report, "history-self-score").latency_deadline);
    expect(result.code).toBe(2);
  });

  test("the real pre-#118 entry alone (no unit, no candidate) is unavailable", () => {
    const document = realHistory();
    document.entries = document.entries.filter(
      (value: { commit: string }) => !value.commit.startsWith("e7829dd"),
    );
    const result = run(repo(pilotContract(), document));
    expectUnavailable(verdictsOf(result.report, "history-self-score").latency_deadline);
    expect(result.code).toBe(2);
  });
});
