import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeFailureText } from "../src/ci-reliability-attribution.ts";
import { formatCiReliability } from "../src/ci-reliability-format.ts";
import { ciReliability, type CiReliabilityOptions } from "../src/ci-reliability.ts";

const repo = "owner/repo";
const window = { since: "2026-11-01", until: "2026-11-09" };

type RunSpec = {
  id: number;
  sha: string;
  at: string;
  conclusion?: string | null;
  status?: string;
  event?: string;
  branch?: string;
  pr?: number;
  actor?: string;
  attempt?: number;
  workflow?: number;
};
type JobSpec = {
  id: number;
  name?: string;
  conclusion?: string;
  step?: string;
  steps?: unknown[];
  from?: string;
  to?: string;
};

const stamp = (hour: string) => `2026-11-05T${hour}:00Z`;

function apiRun(spec: RunSpec) {
  return {
    id: spec.id,
    name: spec.workflow === 2 ? "Other" : "CI",
    path: spec.workflow === 2 ? ".github/workflows/other.yml" : ".github/workflows/ci.yml",
    workflow_id: spec.workflow ?? 1,
    head_sha: spec.sha,
    head_branch: spec.branch ?? "feature",
    event: spec.event ?? "pull_request",
    status: spec.status ?? "completed",
    conclusion: spec.conclusion === undefined ? "failure" : spec.conclusion,
    run_attempt: spec.attempt ?? 1,
    created_at: stamp(spec.at),
    run_started_at: stamp(spec.at),
    updated_at: stamp(spec.at),
    html_url: `https://github.com/${repo}/actions/runs/${spec.id}`,
    actor: {
      login: spec.actor ?? "maintainer",
      type: spec.actor?.endsWith("[bot]") ? "Bot" : "User",
    },
    triggering_actor: { login: spec.actor ?? "maintainer" },
    pull_requests: spec.pr === undefined ? [] : [{ number: spec.pr }],
  };
}

function apiJob(spec: JobSpec) {
  const from = stamp(spec.from ?? "10:00");
  const to = stamp(spec.to ?? "10:10");
  const failed = (spec.conclusion ?? "failure") === "failure";
  return {
    id: spec.id,
    name: spec.name ?? "test",
    html_url: `https://github.com/${repo}/actions/runs/1/job/${spec.id}`,
    conclusion: spec.conclusion ?? "failure",
    created_at: from,
    started_at: from,
    completed_at: to,
    steps: spec.steps ?? [
      {
        name: spec.step ?? "Run tests",
        number: 1,
        conclusion: spec.conclusion ?? "failure",
        started_at: from,
        completed_at: to,
      },
      ...(failed
        ? [{ name: "Post", number: 2, conclusion: "skipped", started_at: to, completed_at: to }]
        : []),
    ],
  };
}

const logOf = (at: string, ...lines: string[]) =>
  lines.map((line) => `2026-11-05T${at}:30.0000000Z ${line}`).join("\n");

class Fixture {
  readonly responses = new Map<string, unknown>();
  readonly logs = new Map<number, string>();
  readonly runs: ReturnType<typeof apiRun>[] = [];
  pulls: unknown = [];

  constructor() {
    this.responses.set(`repos/${repo}`, { default_branch: "main" });
  }

  /** Adds an attempt; the highest attempt of a run becomes the listed run. */
  add(spec: RunSpec, jobs: JobSpec[] = [], annotations: string[] = []): this {
    const attempt = spec.attempt ?? 1;
    const listedIndex = this.runs.findIndex((run) => run.id === spec.id);
    const run = apiRun(spec);
    if (listedIndex >= 0) {
      this.responses.set(
        `repos/${repo}/actions/runs/${spec.id}/attempts/${this.runs[listedIndex]!.run_attempt}`,
        this.runs[listedIndex],
      );
      this.runs[listedIndex] = run;
    } else this.runs.unshift(run);
    this.responses.set(
      `repos/${repo}/actions/runs/${spec.id}/attempts/${attempt}/jobs?per_page=100&page=1`,
      {
        jobs: jobs.map(apiJob),
      },
    );
    for (const job of jobs)
      this.responses.set(
        `repos/${repo}/check-runs/${job.id}/annotations?per_page=50`,
        annotations.map((message) => ({ annotation_level: "failure", message })),
      );
    return this;
  }

  report(options: Partial<CiReliabilityOptions> = {}) {
    this.responses.set(
      `repos/${repo}/actions/runs?per_page=100&page=1&created=${window.since}..${window.until}`,
      { workflow_runs: [...this.runs].sort((left, right) => right.id - left.id) },
    );
    this.responses.set(
      `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`,
      this.pulls,
    );
    return ciReliability("/", {
      repo,
      ...window,
      api: (path) => {
        if (!this.responses.has(path)) throw new Error(`HTTP 404: ${path}`);
        return this.responses.get(path);
      },
      text: (path) => {
        const id = Number(/jobs\/(\d+)\/logs/.exec(path)?.[1]);
        if (!this.logs.has(id)) throw new Error("HTTP 410: logs expired");
        return this.logs.get(id)!;
      },
      ...options,
    });
  }
}

const passing = (id: number) => [{ id, conclusion: "success" }];

describe("ci reliability scenarios", () => {
  test("(a) deduplicates a same-SHA rerun and leaves an unexplained green rerun unknown", () => {
    const fixture = new Fixture()
      .add({ id: 10, sha: "aaa", at: "10:00", pr: 1 }, [{ id: 101 }])
      .add({ id: 10, sha: "aaa", at: "10:00", pr: 1, attempt: 2, conclusion: "success" }, [
        { id: 102, conclusion: "success", from: "11:00", to: "11:30" },
      ]);
    fixture.logs.set(101, logOf("10:05", "##[error]Process completed with exit code 1."));

    const { data, status } = fixture.report();

    expect(status).toBe("passed");
    expect(data.firstAttempt).toMatchObject({ successes: 0, denominator: 1, rate: 0 });
    expect(data.redToGreen.perHead).toMatchObject({ samples: 1, stillRed: 0 });
    expect(data.redToGreen.heads[0]).toMatchObject({
      headSha: "aaa",
      state: "recovered",
      firstRedRunId: 10,
      firstRedAttempt: 1,
      greenRunId: 10,
      secondsToGreen: 4800,
    });
    const failure = data.failures[0]!;
    expect(failure.attempts[0]).toMatchObject({ runId: 10, attempt: 1 });
    expect(failure.firstFailingJob?.url).toContain("/job/101");
    expect(failure.firstFailingStep?.name).toBe("Run tests");
    expect(failure.attribution.status).toBe("unclassified");
    expect(failure.attribution.evidence).toContainEqual(
      expect.objectContaining({ kind: "same-head-retry", outcome: "neutral" }),
    );
    expect(data.attribution.unclassified).toBe(1);
  });

  test("(b) never credits a later green head to the failing head", () => {
    const fixture = new Fixture()
      .add({ id: 20, sha: "old", at: "10:00", pr: 2 }, [{ id: 201 }])
      .add({ id: 21, sha: "new", at: "11:00", pr: 2, conclusion: "success" }, [
        { id: 211, conclusion: "success", from: "11:00", to: "11:20" },
      ]);

    const { data } = fixture.report();

    expect(data.firstAttempt).toMatchObject({ successes: 1, denominator: 2 });
    expect(data.redToGreen.perHead).toMatchObject({
      samples: 0,
      stillRed: 0,
      supersededWithoutGreen: 1,
    });
    expect(data.redToGreen.heads[0]).toMatchObject({
      headSha: "old",
      state: "superseded",
      greenRunId: null,
    });
    expect(data.redToGreen.pullRequests[0]).toMatchObject({
      firstRedSha: "old",
      greenSha: "new",
      headsCrossed: 2,
      secondsToGreen: 4200,
    });
    expect(data.failures[0]!.attribution.evidence).not.toContainEqual(
      expect.objectContaining({ kind: "same-head-retry" }),
    );
  });

  test("(c) confirms a pre-existing failure when the default branch already failed the same way", () => {
    const error = "##[error]expected 3 but received 4 in parser.test.ts";
    const fixture = new Fixture()
      .add({ id: 30, sha: "base", at: "08:00", event: "push", branch: "main" }, [
        { id: 301, from: "08:00", to: "08:10" },
      ])
      .add({ id: 31, sha: "head", at: "10:00", pr: 3 }, [{ id: 311 }]);
    fixture.logs.set(301, logOf("08:05", error));
    fixture.logs.set(311, logOf("10:05", error));

    const { data } = fixture.report({ event: "pull_request" });

    expect(data.failures).toHaveLength(1);
    expect(data.failures[0]!.attribution).toMatchObject({
      status: "confirmed",
      category: "pre-existing-baseline",
    });
    expect(data.failures[0]!.attribution.evidence).toContainEqual(
      expect.objectContaining({ kind: "base-comparison", sourceRunIds: [30], outcome: "supports" }),
    );
    expect(data.attribution.confirmed["pre-existing-baseline"]).toBe(1);
    expect(data.recurringConfirmedCauses[0]).toMatchObject({
      category: "pre-existing-baseline",
      wastedRunnerSeconds: 600,
      runIds: [31],
    });
  });

  test("(c) a passing default branch keeps a one-off failure a candidate-regression hypothesis", () => {
    const fixture = new Fixture()
      .add(
        { id: 32, sha: "base", at: "08:00", event: "push", branch: "main", conclusion: "success" },
        [{ id: 321, conclusion: "success", from: "08:00", to: "08:10" }],
      )
      .add({ id: 33, sha: "head", at: "10:00", pr: 4 }, [{ id: 331 }]);

    const { attribution } = fixture.report({ event: "pull_request" }).data.failures[0]!;

    expect(attribution).toMatchObject({
      status: "hypothesis",
      category: "unavailable-unknown",
      hypothesis: "candidate-regression",
    });
  });

  test("(c) a reproduced failure over a passing default branch confirms a candidate regression", () => {
    const fixture = new Fixture()
      .add(
        { id: 34, sha: "base", at: "08:00", event: "push", branch: "main", conclusion: "success" },
        [{ id: 341, conclusion: "success", from: "08:00", to: "08:10" }],
      )
      .add({ id: 35, sha: "head", at: "10:00", pr: 5 }, [{ id: 351 }])
      .add({ id: 35, sha: "head", at: "10:00", pr: 5, attempt: 2 }, [
        { id: 352, from: "11:00", to: "11:10" },
      ]);
    fixture.logs.set(351, logOf("10:05", "##[error]assertion failed"));
    fixture.logs.set(352, logOf("11:05", "##[error]assertion failed"));

    const { data } = fixture.report({ event: "pull_request" });

    expect(data.failures).toHaveLength(1);
    expect(data.failures[0]!.attribution).toMatchObject({
      status: "confirmed",
      category: "candidate-regression",
    });
    expect(data.redToGreen.perHead.stillRed).toBe(1);
  });

  test("(d) confirms a zero-step billing refusal without reading logs", () => {
    const fixture = new Fixture().add(
      { id: 40, sha: "bill", at: "10:00", pr: 6 },
      [{ id: 401, steps: [] }],
      [
        "The job was not started because recent account payments have failed or your spending limit needs to be increased.",
      ],
    );

    const { data } = fixture.report();

    expect(data.failures[0]).toMatchObject({ zeroStep: true, firstFailingStep: null });
    expect(data.failures[0]!.attribution).toMatchObject({
      status: "confirmed",
      category: "environment-infrastructure",
    });
    expect(data.coverage.warnings).toEqual([]);
  });

  test("(d) a zero-step job without a platform report stays a hypothesis", () => {
    const fixture = new Fixture().add({ id: 41, sha: "bare", at: "10:00", pr: 7 }, [
      { id: 411, steps: [] },
    ]);

    expect(fixture.report().data.failures[0]!.attribution).toMatchObject({
      status: "hypothesis",
      hypothesis: "environment-infrastructure",
    });
  });

  test("(e) a 504 alone is a hypothesis and a green same-head retry confirms infrastructure", () => {
    const line = "curl: (22) The requested URL returned error: 504";
    const alone = new Fixture().add({ id: 50, sha: "dl", at: "10:00", pr: 8 }, [{ id: 501 }]);
    alone.logs.set(501, logOf("10:05", line, "##[error]Process completed with exit code 22."));
    expect(alone.report().data.failures[0]!.attribution).toMatchObject({
      status: "hypothesis",
      category: "unavailable-unknown",
      hypothesis: "environment-infrastructure",
    });

    const retried = new Fixture()
      .add({ id: 51, sha: "dl", at: "10:00", pr: 8 }, [{ id: 511 }])
      .add(
        { id: 51, sha: "dl", at: "10:00", pr: 8, attempt: 2, conclusion: "success" },
        passing(512),
      );
    retried.logs.set(511, logOf("10:05", line));
    const failure = retried.report().data.failures[0]!;
    expect(failure.attribution).toMatchObject({
      status: "confirmed",
      category: "environment-infrastructure",
    });
    expect(failure.signal).toEqual({ text: line, source: "job-log" });
  });

  test("(f) a browser readiness timeout needs unchanged-code evidence, not a green rerun", () => {
    const line = "##[error]Timed out 5000ms waiting for the app readiness marker";
    const retried = new Fixture()
      .add({ id: 60, sha: "ui", at: "10:00", pr: 9 }, [{ id: 601, step: "Browser" }])
      .add(
        { id: 60, sha: "ui", at: "10:00", pr: 9, attempt: 2, conclusion: "success" },
        passing(602),
      );
    retried.logs.set(601, logOf("10:05", line));
    expect(retried.report().data.failures[0]!.attribution).toMatchObject({
      status: "hypothesis",
      hypothesis: "test-harness",
    });

    const onBase = new Fixture()
      .add({ id: 61, sha: "base", at: "08:00", event: "push", branch: "main" }, [
        { id: 611, step: "Browser", from: "08:00", to: "08:10" },
      ])
      .add({ id: 62, sha: "ui", at: "10:00", pr: 9 }, [{ id: 621, step: "Browser" }]);
    onBase.logs.set(611, logOf("08:05", line));
    onBase.logs.set(621, logOf("10:05", line));
    expect(onBase.report({ event: "pull_request" }).data.failures[0]!.attribution).toMatchObject({
      status: "confirmed",
      category: "test-harness",
    });
  });

  test("(g) recognizes noisy performance only in a performance context", () => {
    const noisy = new Fixture()
      .add({ id: 70, sha: "wasm", at: "10:00", pr: 10 }, [
        { id: 701, name: "benchmarks", step: "Compare" },
      ])
      .add(
        { id: 70, sha: "wasm", at: "10:00", pr: 10, attempt: 2, conclusion: "success" },
        passing(702),
      );
    noisy.logs.set(701, logOf("10:05", "##[error]ratio 1.17 exceeds allowed 1.10"));
    expect(noisy.report().data.failures[0]!.attribution).toMatchObject({
      status: "confirmed",
      category: "noisy-performance",
    });

    const unrelated = new Fixture().add({ id: 71, sha: "app", at: "10:00", pr: 11 }, [{ id: 711 }]);
    unrelated.logs.set(711, logOf("10:05", "##[error]aspect ratio 1.17 is wrong"));
    expect(unrelated.report().data.failures[0]!.attribution.hypothesis).toBeNull();
  });

  test("(h) excludes a deliberately cancelled superseded run from the denominator", () => {
    const fixture = new Fixture()
      .add({ id: 80, sha: "first", at: "10:00", pr: 12, conclusion: "cancelled" }, [
        { id: 801, conclusion: "cancelled" },
      ])
      .add({ id: 81, sha: "second", at: "11:00", pr: 12, conclusion: "success" }, passing(811))
      .add({ id: 82, sha: "lone", at: "12:00", pr: 13, conclusion: "cancelled" }, [
        { id: 821, conclusion: "cancelled" },
      ]);

    const { firstAttempt, attribution, redToGreen } = fixture.report().data;

    expect(firstAttempt).toMatchObject({ successes: 1, denominator: 1, rate: 1 });
    expect(firstAttempt.excluded).toMatchObject({ cancelledSuperseded: 1, cancelled: 1 });
    expect(attribution.incidents).toBe(0);
    expect(redToGreen.heads).toEqual([]);
  });

  test("(i) never counts queued or in-progress runs as failures", () => {
    const fixture = new Fixture()
      .add({ id: 90, sha: "q", at: "10:00", pr: 14, status: "queued", conclusion: null })
      .add({ id: 91, sha: "p", at: "10:30", pr: 15, status: "in_progress", conclusion: null })
      .add({ id: 92, sha: "r", at: "11:00", pr: 16 }, [{ id: 921 }])
      .add({
        id: 92,
        sha: "r",
        at: "11:00",
        pr: 16,
        attempt: 2,
        status: "in_progress",
        conclusion: null,
      });

    const { firstAttempt, redToGreen } = fixture.report().data;

    expect(firstAttempt).toMatchObject({ successes: 0, denominator: 1 });
    expect(firstAttempt.excluded.pending).toBe(2);
    expect(redToGreen.perHead).toMatchObject({ stillRed: 0, pending: 1 });
  });

  test("reports only pending history as a missing-data warning with no rate", () => {
    const fixture = new Fixture().add({
      id: 93,
      sha: "q",
      at: "10:00",
      pr: 17,
      status: "queued",
      conclusion: null,
    });

    const { data, diagnostics } = fixture.report();

    expect(data.firstAttempt.rate).toBeNull();
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "ci-reliability-no-completed-attempts",
    );
    expect(formatCiReliability(data)).toContain("n/a (0 applicable)");
  });
});

describe("ci reliability attribution and coverage", () => {
  const greenBase = { id: 190, sha: "base", at: "08:00", event: "push", branch: "main" };

  test("a repeated setup-action 504 is infrastructure, never a confirmed regression", () => {
    const annotations = ["Error: Unexpected HTTP response: 504"];
    const fixture = new Fixture()
      .add({ ...greenBase, conclusion: "success" }, passing(1901))
      .add(
        { id: 191, sha: "h", at: "10:00", pr: 91 },
        [{ id: 1911, step: "Set up Bun" }],
        annotations,
      )
      .add(
        { id: 191, sha: "h", at: "10:00", pr: 91, attempt: 2 },
        [{ id: 1912, step: "Set up Bun", from: "11:00", to: "11:10" }],
        annotations,
      );

    const { attribution, signal } = fixture.report({ event: "pull_request" }).data.failures[0]!;

    expect(attribution).toMatchObject({
      status: "hypothesis",
      hypothesis: "environment-infrastructure",
    });
    expect(signal?.source).toBe("check-annotation");
  });

  test("a repeat without failure text does not confirm a regression", () => {
    const fixture = new Fixture()
      .add({ ...greenBase, conclusion: "success" }, passing(1921))
      .add({ id: 193, sha: "h", at: "10:00", pr: 93 }, [{ id: 1931 }])
      .add({ id: 193, sha: "h", at: "10:00", pr: 93, attempt: 2 }, [
        { id: 1932, from: "11:00", to: "11:10" },
      ]);

    expect(fixture.report({ event: "pull_request" }).data.failures[0]!.attribution).toMatchObject({
      status: "hypothesis",
      hypothesis: "candidate-regression",
    });
  });

  test("a shared job and step without failure text is not a base match", () => {
    const fixture = new Fixture()
      .add({ ...greenBase, id: 194 }, [{ id: 1941, from: "08:00", to: "08:10" }])
      .add({ id: 195, sha: "h", at: "10:00", pr: 95 }, [{ id: 1951 }]);

    const { attribution } = fixture.report({ event: "pull_request" }).data.failures[0]!;

    expect(attribution.status).toBe("unclassified");
    expect(attribution.evidence).toContainEqual(
      expect.objectContaining({ kind: "base-comparison", outcome: "unavailable" }),
    );
  });

  test("ignores warning annotations and strips color codes from signals", () => {
    const fixture = new Fixture();
    fixture.add({ id: 196, sha: "h", at: "10:00", pr: 96 }, [{ id: 1961 }]);
    fixture.responses.set(`repos/${repo}/check-runs/1961/annotations?per_page=50`, [
      { annotation_level: "warning", message: "Node.js 20 is deprecated." },
      { annotation_level: "failure", message: "Process completed with exit code 1." },
    ]);
    fixture.logs.set(1961, logOf("10:05", "##[error]\u001b[31mexpected 1 to be 2\u001b[0m"));

    expect(fixture.report().data.failures[0]!.signal).toEqual({
      text: "expected 1 to be 2",
      source: "job-log",
    });
  });

  test("does not read a hypothesis from the title of a test that passed", () => {
    const fixture = new Fixture().add({ id: 198, sha: "h", at: "10:00", pr: 98 }, [
      { id: 1981, name: "e2e performance" },
    ]);
    fixture.logs.set(
      1981,
      logOf(
        "10:05",
        "  ✓  44 [chromium] › startup changes apply before readiness timeout",
        "  ✓  45 [chromium] › frame ratio stays under 16",
        "  ✘  46 [chromium] › the map renders labels",
      ),
    );

    const failure = fixture.report().data.failures[0]!;

    expect(failure.attribution.hypothesis).toBeNull();
    expect(failure.signal).toEqual({
      text: "✘  46 [chromium] › the map renders labels",
      source: "job-log",
    });
  });

  test("orders attempts by their own start even though the list repeats the first created_at", () => {
    const fixture = new Fixture()
      .add({ id: 197, sha: "h", at: "10:00", pr: 97 }, [{ id: 1971 }])
      .add({ id: 197, sha: "h", at: "10:00", pr: 97, attempt: 2 }, [
        { id: 1972, from: "11:00", to: "11:10" },
      ])
      .add({ id: 197, sha: "h", at: "10:00", pr: 97, attempt: 3, conclusion: "success" }, [
        { id: 1973, conclusion: "success", from: "12:00", to: "12:10" },
      ]);
    const attemptTwo = `repos/${repo}/actions/runs/197/attempts/2`;
    fixture.responses.set(attemptTwo, {
      ...(fixture.responses.get(attemptTwo) as object),
      created_at: stamp("11:00"),
      run_started_at: stamp("11:00"),
    });
    fixture.runs[0]!.created_at = "2026-11-05T09:59:59Z";
    fixture.runs[0]!.run_started_at = stamp("12:00");

    const { firstAttempt, redToGreen } = fixture.report().data;

    expect(firstAttempt.excluded.firstAttemptUnavailable).toBe(0);
    expect(firstAttempt).toMatchObject({ successes: 0, denominator: 1 });
    expect(redToGreen.heads[0]).toMatchObject({ firstRedAttempt: 1, state: "recovered" });
  });

  test("a maintainer annotation confirms by run or fingerprint and reports the annotator", () => {
    const fixture = new Fixture().add({ id: 100, sha: "x", at: "10:00", pr: 20 }, [{ id: 1001 }]);
    fixture.logs.set(1001, logOf("10:05", "##[error]flaked on shared state"));
    const fingerprint = fixture.report().data.failures[0]!.fingerprint.id;
    const directory = mkdtempSync(join(tmpdir(), "ci-reliability-"));
    const write = (name: string, annotations: unknown[]) => {
      writeFileSync(
        join(directory, name),
        JSON.stringify({ schemaVersion: "coding-tooling/ci-failure-annotations/v1", annotations }),
      );
      return join(directory, name);
    };

    const byRun = fixture.report({
      annotationsPath: write("run.json", [
        { runId: 100, category: "test-harness", annotator: "maintainer", reference: "#551" },
      ]),
    });
    expect(byRun.data.failures[0]!.attribution).toMatchObject({
      status: "confirmed",
      category: "test-harness",
    });
    expect(byRun.data.recurringConfirmedCauses).toHaveLength(1);

    const byFingerprint = fixture.report({
      annotationsPath: write("fingerprint.json", [
        { fingerprint, category: "pre-existing-baseline", annotator: "maintainer" },
      ]),
    });
    expect(byFingerprint.data.failures[0]!.attribution.category).toBe("pre-existing-baseline");

    const unknown = fixture.report({
      annotationsPath: write("unknown.json", [
        { runId: 100, category: "unavailable-unknown", annotator: "maintainer" },
      ]),
    });
    expect(unknown.data.attribution.unclassified).toBe(1);
    expect(unknown.data.recurringConfirmedCauses).toEqual([]);

    const invalid = fixture.report({
      annotationsPath: write("bad.json", [
        { runId: 100, category: "cosmic-rays", annotator: "me" },
      ]),
    });
    expect(invalid.status).toBe("unavailable");
    expect(invalid.diagnostics[0]!.code).toBe("ci-reliability-annotations-invalid");
  });

  test("ranks confirmed causes by wasted runner time and ignores hypotheses", () => {
    const line = "curl: (22) The requested URL returned error: 503";
    const fixture = new Fixture();
    const addRecovered = (id: number, sha: string, name: string, to: string) => {
      fixture
        .add({ id, sha, at: "10:00", pr: id }, [{ id: id * 10 + 1, name, to }])
        .add(
          { id, sha, at: "10:00", pr: id, attempt: 2, conclusion: "success" },
          passing(id * 10 + 2),
        );
      fixture.logs.set(id * 10 + 1, logOf("10:05", line));
    };
    addRecovered(110, "s1", "small", "10:05");
    addRecovered(111, "s2", "large", "10:30");
    fixture.add({ id: 112, sha: "s3", at: "10:00", pr: 112 }, [{ id: 1121, name: "hypothesis" }]);
    fixture.logs.set(1121, logOf("10:05", line));

    const causes = fixture.report().data.recurringConfirmedCauses;

    expect(causes.map((cause) => cause.label.split(" | ")[0])).toEqual(["large", "small"]);
    expect(causes[0]).toMatchObject({ wastedRunnerSeconds: 1800, runIds: [111] });
  });

  test("attributes runner time to merged pull requests and labels it as runner time", () => {
    const fixture = new Fixture()
      .add({ id: 120, sha: "m1", at: "10:00", pr: 30 }, [{ id: 1201, to: "10:10" }])
      .add({ id: 120, sha: "m1", at: "10:00", pr: 30, attempt: 2, conclusion: "success" }, [
        { id: 1202, conclusion: "success", from: "11:00", to: "11:20" },
      ])
      .add({ id: 121, sha: "m2", at: "12:00", pr: 31, conclusion: "success" }, [
        { id: 1211, conclusion: "success", from: "12:00", to: "12:05" },
      ]);
    fixture.pulls = [
      {
        number: 30,
        created_at: "2026-11-05T09:00:00Z",
        updated_at: "2026-11-06T09:00:00Z",
        closed_at: "2026-11-06T09:00:00Z",
        merged_at: "2026-11-06T09:00:00Z",
        head: { ref: "a" },
      },
      {
        number: 31,
        created_at: "2026-11-05T09:00:00Z",
        updated_at: "2026-11-06T09:00:00Z",
        closed_at: "2026-11-06T09:00:00Z",
        merged_at: "2026-11-06T09:00:00Z",
        head: { ref: "b" },
      },
      {
        number: 32,
        created_at: "2026-10-01T09:00:00Z",
        updated_at: "2026-11-06T09:00:00Z",
        closed_at: "2026-11-06T09:00:00Z",
        merged_at: "2026-11-06T09:00:00Z",
        head: { ref: "c" },
      },
      {
        number: 33,
        created_at: "2026-11-05T09:00:00Z",
        updated_at: "2026-11-06T09:00:00Z",
        closed_at: "2026-11-06T09:00:00Z",
        merged_at: null,
        head: { ref: "d" },
      },
    ];

    const { runnerTime } = fixture.report().data;

    expect(runnerTime.label).toBe("runner time, not billing");
    expect(runnerTime.mergedPullRequests).toBe(2);
    expect(runnerTime.pullRequests[0]).toEqual({
      pullRequest: 30,
      mergedAt: "2026-11-06T09:00:00Z",
      runnerSeconds: 1800,
      attempts: 2,
    });
    expect(runnerTime.excluded.openedBeforeCoverage).toBe(1);
    expect(runnerTime.perMergedPullRequest?.median).toBe(300);
  });

  test("counts a job reused by a partial rerun once", () => {
    const fixture = new Fixture()
      .add({ id: 130, sha: "pr", at: "10:00", pr: 40 }, [
        { id: 1301, name: "build", conclusion: "success", to: "10:10" },
        { id: 1302, name: "test", from: "10:10", to: "10:20" },
      ])
      .add({ id: 130, sha: "pr", at: "10:00", pr: 40, attempt: 2, conclusion: "success" }, [
        { id: 1301, name: "build", conclusion: "success", to: "10:10" },
        { id: 1303, name: "test", conclusion: "success", from: "11:00", to: "11:10" },
      ]);
    fixture.pulls = [
      {
        number: 40,
        created_at: "2026-11-05T09:00:00Z",
        updated_at: "2026-11-06T09:00:00Z",
        closed_at: "2026-11-06T09:00:00Z",
        merged_at: "2026-11-06T09:00:00Z",
        head: { ref: "a" },
      },
    ];

    expect(fixture.report().data.runnerTime.pullRequests[0]!.runnerSeconds).toBe(1800);
  });

  test("segments the first-attempt rate by scope and actor", () => {
    const fixture = new Fixture()
      .add({ id: 140, sha: "h", at: "10:00", pr: 50, conclusion: "success" }, passing(1401))
      .add({ id: 141, sha: "b", at: "10:00", pr: 51, actor: "renovate[bot]" }, [{ id: 1411 }])
      .add(
        { id: 142, sha: "c", at: "10:00", event: "push", branch: "main", conclusion: "success" },
        passing(1421),
      );

    expect(fixture.report().data.firstAttempt.segments).toEqual([
      { scope: "default-branch", actorKind: "human", successes: 1, denominator: 1, rate: 1 },
      { scope: "pull-request", actorKind: "bot", successes: 0, denominator: 1, rate: 0 },
      { scope: "pull-request", actorKind: "human", successes: 1, denominator: 1, rate: 1 },
    ]);
  });

  test("keeps separate workflows and events on one SHA apart", () => {
    const fixture = new Fixture()
      .add({ id: 150, sha: "same", at: "10:00", pr: 60 }, [{ id: 1501 }])
      .add(
        { id: 151, sha: "same", at: "10:30", pr: 60, workflow: 2, conclusion: "success" },
        passing(1511),
      )
      .add(
        { id: 152, sha: "same", at: "11:00", event: "workflow_dispatch", conclusion: "success" },
        passing(1521),
      );

    const { data } = fixture.report();

    expect(data.firstAttempt.denominator).toBe(3);
    expect(data.redToGreen.heads[0]).toMatchObject({ state: "still-red", greenRunId: null });
  });

  test("warns about truncated history, inaccessible logs and missing merge metadata", () => {
    const fixture = new Fixture()
      .add({ id: 160, sha: "old", at: "09:00", pr: 70 }, [{ id: 1601 }])
      .add({ id: 161, sha: "new", at: "10:00", pr: 71 }, [{ id: 1611 }]);
    fixture.logs.set(1611, logOf("10:05", "##[error]boom"));

    const result = fixture.report({ maxRuns: 2 });
    expect(result.data.coverage.runsRead).toBe(2);
    expect(
      result.data.failures.find((row) => row.headSha === "old")!.attribution.evidence,
    ).toContainEqual(expect.objectContaining({ kind: "logs", outcome: "unavailable" }));
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "ci-reliability-logs-inaccessible",
    );

    const truncated = fixture.report({ maxRuns: 1 });
    const codes = truncated.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("ci-reliability-history-truncated");

    fixture.responses.set(
      `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`,
      undefined,
    );
    const api = (path: string) => {
      if (path.includes("/pulls?")) throw new Error("HTTP 403");
      if (!fixture.responses.has(path)) throw new Error(`HTTP 404: ${path}`);
      return fixture.responses.get(path);
    };
    const noPulls = ciReliability("/", { repo, ...window, api, text: () => "" });
    expect(noPulls.diagnostics.map((entry) => entry.code)).toContain(
      "ci-reliability-pull-metadata-unavailable",
    );
    expect(noPulls.data.runnerTime.perMergedPullRequest).toBeNull();
    expect(formatCiReliability(noPulls.data)).toContain(
      "Runner time per merged PR (not billing): unavailable",
    );
  });

  test("a failure the jobs API cannot describe is counted without a fabricated fingerprint", () => {
    const fixture = new Fixture().add({ id: 170, sha: "gone", at: "10:00", pr: 80 });
    fixture.responses.delete(`repos/${repo}/actions/runs/170/attempts/1/jobs?per_page=100&page=1`);

    const { data, diagnostics } = fixture.report();

    expect(data.failures).toEqual([]);
    expect(data.coverage).toMatchObject({ failedAttempts: 1, failedAttemptsWithoutJobs: 1 });
    expect(data.redToGreen.heads).toHaveLength(1);
    expect(diagnostics.map((entry) => entry.code)).toContain("ci-reliability-jobs-unavailable");
  });

  test("normalizes run-specific values out of fingerprints", () => {
    expect(
      normalizeFailureText(
        "Timeout 5000ms at 2026-11-05T10:00:00Z on https://host.test/a?b=1 for deadbeef1234 in /tmp/x/y",
      ),
    ).toBe("timeout #ms at <time> on https://host.test for <hex> in <path>");
    expect(normalizeFailureText("HTTP 504")).toBe(normalizeFailureText("HTTP 503"));
  });

  test("is unavailable when gh fails and renders a table", () => {
    const missing = ciReliability("/", {
      repo: "owner/missing",
      api: () => {
        throw new Error("HTTP 404");
      },
    });
    expect(missing.status).toBe("unavailable");
    expect(missing.diagnostics[0]!.code).toBe("ci-reliability-gh-unavailable");

    const fixture = new Fixture().add({ id: 180, sha: "abcdef0123456", at: "10:00", pr: 90 }, [
      { id: 1801 },
    ]);
    const table = formatCiReliability(fixture.report().data);
    expect(table).toContain("First-attempt success per head: 0.0% (0/1)");
    expect(table).toContain("not a gate");
    expect(table).toContain("run 180#1 unclassified: test › Run tests");
  });

  test("CLI rejects bad flags", () => {
    const router = resolve(import.meta.dir, "../src/router.ts");
    for (const args of [
      ["--max-runs", "0"],
      ["--days", "0"],
      ["--days", "3", "--since", "2026-11-01"],
      ["--since", "yesterday"],
      ["--until", "2026-11-09"],
      ["--repo", "not a repo"],
      ["--surprise"],
    ]) {
      const bad = spawnSync(process.execPath, [router, "ci", "reliability", ...args], {
        encoding: "utf8",
      });
      expect(bad.status).toBe(2);
    }
  });
});
