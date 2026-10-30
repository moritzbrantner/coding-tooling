import type { Diagnostic, ResultEnvelope } from "./model.ts";
import { runCommand } from "./shared.ts";

export const ciDurationsSchemaVersion = "coding-tooling/ci-durations/v1";

/** Returns the parsed JSON for a GitHub REST path, or throws with the gh error. */
export type GitHubApi = (path: string) => unknown;

export type CiDurationOptions = {
  /** owner/name; defaults to the repository `gh` resolves from the root. */
  repo?: string;
  /** Workflow name or file name (for example `Validate` or `validate.yml`). */
  workflow?: string;
  /** Successful runs per workflow (default 10). */
  runs?: number;
  /** Branch filter; defaults to the repository default branch. */
  branch?: string;
  /** Drop the branch filter (for example with `event: "pull_request"`). */
  anyBranch?: boolean;
  /** Trigger event filter (for example `push` or `pull_request`). */
  event?: string;
  /** Maximum job and step rows per workflow (default 10). */
  limit?: number;
  api?: GitHubApi;
};

export type DurationStats = { median: number; p90: number; max: number };

export type CiJobDuration = {
  name: string;
  runs: number;
  seconds: DurationStats;
  queueSeconds: DurationStats;
};

export type CiStepDuration = { job: string; step: string; runs: number; seconds: DurationStats };

export type CiWorkflowDurations = {
  name: string;
  path: string;
  runs: number;
  runIds: number[];
  /** First job created to last job completed, including queue. */
  wallSeconds: DurationStats;
  /** Summed per-job wait between job creation and runner start. */
  queueSeconds: DurationStats;
  /** Summed per-job execution time (runner time). */
  jobSeconds: DurationStats;
  /** Most frequent timestamp-derived chain ending at the last job to finish. */
  criticalPath: { jobs: string[]; runs: number };
  jobs: CiJobDuration[];
  steps: CiStepDuration[];
};

export type CiDurationsData = {
  schemaVersion: typeof ciDurationsSchemaVersion;
  repo: string;
  branch: string | null;
  event: string | null;
  runsPerWorkflow: number;
  workflows: CiWorkflowDurations[];
  limitations: string[];
};

type ApiRun = {
  id: number;
  run_started_at: string;
  updated_at: string;
};
type ApiStep = {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};
type ApiJob = {
  name: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: ApiStep[];
};
type TimedJob = { name: string; created: number; started: number; completed: number; job: ApiJob };

export function ghApi(path: string): unknown {
  const result = runCommand("gh", ["api", "-H", "Accept: application/vnd.github+json", path]);
  if (result.status !== 0) throw new Error((result.error ?? result.stderr).trim());
  return JSON.parse(result.stdout);
}

const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

/** Nearest-rank percentile of a non-empty list. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function stats(values: number[]): DurationStats {
  if (values.length === 0) return { median: 0, p90: 0, max: 0 };
  return {
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  };
}

function timedJobs(jobs: ApiJob[]): TimedJob[] {
  return jobs.flatMap((job) =>
    job.conclusion === "skipped" || !job.started_at || !job.completed_at
      ? []
      : [
          {
            name: job.name,
            created: Date.parse(job.created_at),
            started: Date.parse(job.started_at),
            completed: Date.parse(job.completed_at),
            job,
          },
        ],
  );
}

/**
 * The API does not expose `needs`, so the chain is derived from timestamps: a job is created when
 * its dependencies finish, so its predecessor is the latest job that completed by then.
 */
function criticalPath(jobs: TimedJob[]): string[] {
  const slackMs = 3000;
  let current = jobs.reduce<TimedJob | undefined>(
    (last, job) => (!last || job.completed > last.completed ? job : last),
    undefined,
  );
  const path: string[] = [];
  while (current) {
    path.unshift(current.name);
    const created: number = current.created;
    current = jobs
      .filter((job) => job !== current && job.completed <= created + slackMs)
      .reduce<TimedJob | undefined>(
        (last, job) => (!last || job.completed > last.completed ? job : last),
        undefined,
      );
    if (current && path.includes(current.name)) break;
  }
  return path;
}

function mostCommon(paths: string[][]): { jobs: string[]; runs: number } {
  const counts = new Map<string, { jobs: string[]; runs: number }>();
  for (const jobs of paths) {
    const key = jobs.join("\0");
    const entry = counts.get(key) ?? { jobs, runs: 0 };
    entry.runs += 1;
    counts.set(key, entry);
  }
  return (
    [...counts.values()].sort((left, right) => right.runs - left.runs)[0] ?? {
      jobs: [],
      runs: 0,
    }
  );
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function summarize(
  workflow: { name: string; path: string },
  runs: { run: ApiRun; jobs: ApiJob[] }[],
  limit: number,
): CiWorkflowDurations {
  const wall: number[] = [];
  const queue: number[] = [];
  const execution: number[] = [];
  const paths: string[][] = [];
  const jobDurations = new Map<string, number[]>();
  const jobQueues = new Map<string, number[]>();
  const stepDurations = new Map<string, number[]>();
  for (const { run, jobs } of runs) {
    const timed = timedJobs(jobs);
    if (timed.length === 0) {
      wall.push(seconds(run.run_started_at, run.updated_at));
      queue.push(0);
      execution.push(0);
      continue;
    }
    const first = Math.min(...timed.map((job) => job.created));
    const last = Math.max(...timed.map((job) => job.completed));
    wall.push((last - first) / 1000);
    queue.push(timed.reduce((sum, job) => sum + (job.started - job.created) / 1000, 0));
    execution.push(timed.reduce((sum, job) => sum + (job.completed - job.started) / 1000, 0));
    paths.push(criticalPath(timed));
    for (const job of timed) {
      push(jobDurations, job.name, (job.completed - job.started) / 1000);
      push(jobQueues, job.name, (job.started - job.created) / 1000);
      for (const step of job.job.steps ?? []) {
        if (step.conclusion === "skipped" || !step.started_at || !step.completed_at) continue;
        push(
          stepDurations,
          `${job.name}\0${step.name}`,
          seconds(step.started_at, step.completed_at),
        );
      }
    }
  }
  const slowest = <T extends { seconds: DurationStats }>(rows: T[]) =>
    rows
      .sort(
        (left, right) =>
          right.seconds.median - left.seconds.median || right.seconds.p90 - left.seconds.p90,
      )
      .slice(0, limit);
  return {
    name: workflow.name,
    path: workflow.path,
    runs: runs.length,
    runIds: runs.map(({ run }) => run.id),
    wallSeconds: stats(wall),
    queueSeconds: stats(queue),
    jobSeconds: stats(execution),
    criticalPath: mostCommon(paths),
    jobs: slowest(
      [...jobDurations].map(([name, values]) => ({
        name,
        runs: values.length,
        seconds: stats(values),
        queueSeconds: stats(jobQueues.get(name) ?? []),
      })),
    ),
    steps: slowest(
      [...stepDurations].map(([key, values]) => {
        const [job, step] = key.split("\0") as [string, string];
        return { job, step, runs: values.length, seconds: stats(values) };
      }),
    ),
  };
}

function resolveRepo(root: string): string | undefined {
  const result = runCommand(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    root,
  );
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/**
 * Read-only CI duration evidence from GitHub workflow run, job and step timestamps: per-workflow
 * wall, queue and runner time, the timestamp-derived critical path, and the slowest jobs and steps
 * over recent successful runs.
 */
export function ciDurations(
  root: string,
  options: CiDurationOptions = {},
): ResultEnvelope<CiDurationsData> {
  const started = Date.now();
  const api = options.api ?? ghApi;
  const runsPerWorkflow = options.runs ?? 10;
  const limit = options.limit ?? 10;
  const diagnostics: Diagnostic[] = [];
  const data: CiDurationsData = {
    schemaVersion: ciDurationsSchemaVersion,
    repo: options.repo ?? "",
    branch: null,
    event: options.event ?? null,
    runsPerWorkflow,
    workflows: [],
    limitations: [
      "Durations come from job and step timestamps (second resolution); logs are not read.",
      "The critical path is inferred from timestamps because the API does not expose job `needs`.",
      "Only successful runs count; skipped jobs and steps are excluded; the latest attempt of each run is used.",
      "Percentiles are nearest-rank over the sampled runs.",
    ],
  };
  const unavailable = (code: string, message: string): ResultEnvelope<CiDurationsData> => {
    diagnostics.push({ code, message });
    return {
      schemaVersion: 1,
      operation: "ci-durations",
      status: "unavailable",
      durationMs: Date.now() - started,
      data,
      diagnostics,
    };
  };
  const repo = options.repo ?? resolveRepo(root);
  if (!repo)
    return unavailable(
      "ci-durations-repo-unknown",
      "Could not resolve the GitHub repository; pass --repo owner/name.",
    );
  data.repo = repo;
  let workflows: { id: number; name: string; path: string; state: string }[];
  try {
    if (!options.anyBranch)
      data.branch =
        options.branch ?? (api(`repos/${repo}`) as { default_branch: string }).default_branch;
    workflows = (
      api(`repos/${repo}/actions/workflows?per_page=100`) as { workflows: typeof workflows }
    ).workflows.filter((workflow) => workflow.state === "active");
  } catch (error) {
    return unavailable("ci-durations-gh-unavailable", `gh api failed: ${(error as Error).message}`);
  }
  if (options.workflow) {
    const wanted = options.workflow.toLowerCase();
    workflows = workflows.filter(
      (workflow) =>
        workflow.name.toLowerCase() === wanted ||
        workflow.path.split("/").pop()?.toLowerCase() === wanted,
    );
    if (workflows.length === 0)
      diagnostics.push({
        code: "ci-durations-workflow-not-found",
        message: `No active workflow named ${options.workflow} in ${repo}.`,
      });
  }
  const query = [
    "status=success",
    `per_page=${runsPerWorkflow}`,
    ...(data.branch ? [`branch=${encodeURIComponent(data.branch)}`] : []),
    ...(data.event ? [`event=${encodeURIComponent(data.event)}`] : []),
  ].join("&");
  for (const workflow of workflows) {
    const runs: { run: ApiRun; jobs: ApiJob[] }[] = [];
    try {
      const listed = (
        api(`repos/${repo}/actions/workflows/${workflow.id}/runs?${query}`) as {
          workflow_runs: ApiRun[];
        }
      ).workflow_runs;
      for (const run of listed) {
        try {
          const jobs = (
            api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`) as { jobs: ApiJob[] }
          ).jobs;
          runs.push({ run, jobs });
        } catch (error) {
          diagnostics.push({
            code: "ci-durations-jobs-unavailable",
            message: `Jobs for run ${run.id} unavailable: ${(error as Error).message}`,
          });
        }
      }
    } catch (error) {
      diagnostics.push({
        code: "ci-durations-runs-unavailable",
        message: `Runs for ${workflow.name} unavailable: ${(error as Error).message}`,
      });
      continue;
    }
    if (runs.length > 0) data.workflows.push(summarize(workflow, runs, limit));
  }
  data.workflows.sort((left, right) => right.wallSeconds.median - left.wallSeconds.median);
  return {
    schemaVersion: 1,
    operation: "ci-durations",
    status: "passed",
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function formatSeconds(value: number): string {
  const total = Math.round(value);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const cell = (value: number) => formatSeconds(value).padStart(7);

/** Plain-text table for `--json`-less runs. */
export function formatCiDurations(data: CiDurationsData): string {
  const scope = [
    data.branch ? `branch ${data.branch}` : "any branch",
    ...(data.event ? [`event ${data.event}`] : []),
  ].join(", ");
  const triple = (value: DurationStats) =>
    `${cell(value.median)} ${cell(value.p90)} ${cell(value.max)}`;
  const header = `${"median".padStart(7)} ${"p90".padStart(7)} ${"max".padStart(7)}`;
  const sections = data.workflows.map((workflow) =>
    [
      `${workflow.name} (${workflow.path}): ${workflow.runs} runs`,
      `  ${"".padEnd(14)}${header}`,
      `  ${"wall".padEnd(14)}${triple(workflow.wallSeconds)}`,
      `  ${"queue".padEnd(14)}${triple(workflow.queueSeconds)}`,
      `  ${"runner time".padEnd(14)}${triple(workflow.jobSeconds)}`,
      `  critical path (${workflow.criticalPath.runs}/${workflow.runs} runs): ${workflow.criticalPath.jobs.join(" > ") || "none"}`,
      `  ${"slowest jobs".padEnd(14)}${header} ${"queue90".padStart(7)}  runs`,
      ...workflow.jobs.map(
        (job) =>
          `  ${"".padEnd(14)}${triple(job.seconds)} ${cell(job.queueSeconds.p90)} ${String(job.runs).padStart(5)}  ${job.name}`,
      ),
      `  ${"slowest steps".padEnd(14)}${header} ${"".padStart(7)}  runs`,
      ...workflow.steps.map(
        (step) =>
          `  ${"".padEnd(14)}${triple(step.seconds)} ${"".padStart(7)} ${String(step.runs).padStart(5)}  ${step.job} › ${step.step}`,
      ),
    ].join("\n"),
  );
  return [
    `CI durations for ${data.repo}: ${scope}, last ${data.runsPerWorkflow} successful runs per workflow.`,
    ...(sections.length === 0 ? ["No successful runs found."] : sections),
  ].join("\n\n");
}
