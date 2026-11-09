import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import {
  describeFailure,
  failedStepLines,
  type ApiJob,
  type ApiStep,
  type FailureDescription,
  type LogAccess,
} from "./ci-reliability-attribution.ts";
import type { GitHubApi } from "./ci-durations.ts";

/** Returns a GitHub REST response body as text (job logs are not JSON). */
export type GitHubTextApi = (path: string) => string;

export type AttemptState =
  | "success"
  | "failure"
  | "pending"
  | "cancelled"
  | "skipped"
  | "not-applicable";

export type ApiRun = {
  id: number;
  name: string;
  path: string;
  workflow_id: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  run_started_at: string;
  updated_at: string;
  html_url: string;
  actor?: { login: string; type?: string } | null;
  triggering_actor?: { login: string; type?: string } | null;
  pull_requests?: { number: number }[] | null;
  head_repository?: { full_name: string } | null;
};

export type Attempt = {
  runId: number;
  attempt: number;
  workflowId: number;
  workflowName: string;
  workflowPath: string;
  event: string;
  headSha: string;
  headBranch: string | null;
  headRepository: string | null;
  scope: "pull-request" | "default-branch" | "other";
  actor: string | null;
  actorKind: "bot" | "human" | "unknown";
  triggeringActor: string | null;
  status: string;
  conclusion: string | null;
  state: AttemptState;
  createdAt: string;
  runStartedAt: string;
  completedAt: string;
  url: string;
  pullRequest: number | null;
  inScope: boolean;
  jobsAvailable: boolean;
  runnerSeconds: number;
  failure: FailureDescription | null;
};

export type CoverageWarning = { code: string; count: number; message: string };

/** Counts missing data by kind so one unreadable history does not print one line per run. */
export class CoverageTally {
  private readonly entries = new Map<string, { what: string; count: number; sample: string }>();

  add(code: string, what: string, sample: string): void {
    const entry = this.entries.get(code) ?? { what, count: 0, sample };
    entry.count += 1;
    this.entries.set(code, entry);
  }

  warnings(): CoverageWarning[] {
    return [...this.entries]
      .map(([code, { what, count, sample }]) => ({
        code,
        count,
        message: `${what}: ${count} (first: ${sample})`,
      }))
      .sort((left, right) => left.code.localeCompare(right.code));
  }
}

export type CollectContext = {
  repo: string;
  defaultBranch: string;
  api: GitHubApi;
  text: GitHubTextApi;
  tally: CoverageTally;
};

export function ghText(path: string, flags: string[] = []): string {
  const result = spawnSync("gh", ["api", ...flags, path], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.error?.message ?? result.stderr).trim());
  return result.stdout;
}

/** Job logs carry color codes, which current `gh` refuses to print unless allowed. */
export function ghLog(path: string): string {
  try {
    return ghText(path, ["--allow-escape-sequences"]);
  } catch (error) {
    if ((error as Error).message.includes("unknown flag")) return ghText(path);
    throw error;
  }
}

const failedConclusions = new Set(["failure", "timed_out", "startup_failure"]);

export function attemptState(status: string, conclusion: string | null): AttemptState {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  if (conclusion !== null && failedConclusions.has(conclusion)) return "failure";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "skipped") return "skipped";
  return "not-applicable";
}

export function matchesWorkflow(run: { name: string; path: string }, wanted?: string): boolean {
  if (!wanted) return true;
  const lower = wanted.toLowerCase();
  const file = run.path.split("@")[0]!.split("/").pop()?.toLowerCase();
  return run.name.toLowerCase() === lower || file === lower;
}

/** Newest-first runs in the window. GitHub serves at most 1000 results for a filtered query. */
export function listRuns(
  context: Pick<CollectContext, "repo" | "api">,
  window: { since: string; until: string | null },
  workflow: string | undefined,
  maxRuns: number,
): { runs: ApiRun[]; truncated: boolean } {
  const runs: ApiRun[] = [];
  const created = `${window.since}..${window.until ?? "*"}`;
  for (let page = 1; page <= 10; page += 1) {
    const listed = (
      context.api(
        `repos/${context.repo}/actions/runs?per_page=100&page=${page}&created=${created}`,
      ) as { workflow_runs: ApiRun[] }
    ).workflow_runs;
    for (const run of listed) {
      if (!matchesWorkflow(run, workflow)) continue;
      if (runs.length === maxRuns) return { runs, truncated: true };
      runs.push(run);
    }
    if (listed.length < 100) return { runs, truncated: false };
  }
  return { runs, truncated: true };
}

function listJobs(context: CollectContext, runId: number, attempt: number): ApiJob[] {
  const jobs: ApiJob[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const listed = (
      context.api(
        `repos/${context.repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      ) as { jobs: ApiJob[] }
    ).jobs;
    jobs.push(...listed);
    if (listed.length < 100) return jobs;
  }
  context.tally.add(
    "ci-reliability-jobs-truncated",
    "Attempts with more jobs than were read",
    `run ${runId} attempt ${attempt}`,
  );
  return jobs;
}

const bySoonestEnd = (left: ApiJob, right: ApiJob) =>
  Date.parse(left.completed_at ?? left.started_at ?? left.created_at) -
  Date.parse(right.completed_at ?? right.started_at ?? right.created_at);

function describeAttemptFailure(
  context: CollectContext,
  run: ApiRun,
  attempt: number,
  jobs: ApiJob[],
): FailureDescription {
  const job =
    jobs
      .filter((candidate) => candidate.conclusion && failedConclusions.has(candidate.conclusion))
      .sort(bySoonestEnd)[0] ?? null;
  const step: ApiStep | null =
    job?.steps
      ?.filter((candidate) => candidate.conclusion && failedConclusions.has(candidate.conclusion))
      .sort((left, right) => (left.number ?? 0) - (right.number ?? 0))[0] ?? null;
  const sample = `run ${run.id} attempt ${attempt}`;
  let annotations: string[] = [];
  let logLines: string[] = [];
  let logs: LogAccess = "not-applicable";
  if (job) {
    try {
      annotations = (
        context.api(`repos/${context.repo}/check-runs/${job.id}/annotations?per_page=50`) as {
          annotation_level?: string;
          message: string;
        }[]
      )
        .filter((annotation) => annotation.annotation_level === "failure")
        .flatMap((annotation) => stripVTControlCharacters(annotation.message).split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("at "));
    } catch {
      context.tally.add(
        "ci-reliability-annotations-unavailable",
        "Failing jobs whose check annotations could not be read",
        sample,
      );
    }
    if ((job.steps ?? []).some((candidate) => candidate.started_at !== null)) {
      try {
        logLines = failedStepLines(
          stripVTControlCharacters(
            context.text(`repos/${context.repo}/actions/jobs/${job.id}/logs`),
          ),
          step,
        );
        logs = "read";
      } catch {
        logs = "unavailable";
        context.tally.add(
          "ci-reliability-logs-inaccessible",
          "Failing jobs whose logs could not be read (expired or inaccessible)",
          sample,
        );
      }
    }
  }
  return describeFailure({
    workflowPath: run.path,
    conclusion: run.conclusion,
    job,
    step,
    annotations,
    logLines,
    logs,
  });
}

function actorKind(actor: ApiRun["actor"]): Attempt["actorKind"] {
  if (!actor) return "unknown";
  return actor.type === "Bot" || actor.login.endsWith("[bot]") ? "bot" : "human";
}

function scopeOf(run: ApiRun, defaultBranch: string): Attempt["scope"] {
  if (run.event.startsWith("pull_request")) return "pull-request";
  return run.head_branch === defaultBranch ? "default-branch" : "other";
}

/**
 * Every attempt of one run, oldest first. The list endpoint returns only the latest attempt, so
 * earlier ones are read individually. A partial rerun copies the jobs it reused into the new
 * attempt with their original timestamps; those are counted once.
 */
export function collectAttempts(
  context: CollectContext,
  latest: ApiRun,
  inScope: boolean,
): Attempt[] {
  const attempts: Attempt[] = [];
  const counted = new Set<string>();
  for (let number = 1; number <= latest.run_attempt; number += 1) {
    let run = latest;
    if (number !== latest.run_attempt) {
      try {
        run = context.api(
          `repos/${context.repo}/actions/runs/${latest.id}/attempts/${number}`,
        ) as ApiRun;
      } catch {
        context.tally.add(
          "ci-reliability-attempt-unavailable",
          "Earlier attempts that could not be read",
          `run ${latest.id} attempt ${number}`,
        );
        continue;
      }
    }
    const state = attemptState(run.status, run.conclusion);
    let jobs: ApiJob[] = [];
    let jobsAvailable = false;
    if (state !== "pending" && (inScope || state === "failure")) {
      try {
        jobs = listJobs(context, run.id, number);
        jobsAvailable = true;
      } catch {
        context.tally.add(
          "ci-reliability-jobs-unavailable",
          "Attempts whose jobs could not be read",
          `run ${run.id} attempt ${number}`,
        );
      }
    }
    let runnerSeconds = 0;
    for (const job of jobs) {
      if (job.conclusion === "skipped") continue;
      if (!job.started_at || !job.completed_at) {
        context.tally.add(
          "ci-reliability-job-timestamps-missing",
          "Jobs without runner timestamps, excluded from runner time",
          `run ${run.id} job ${job.name}`,
        );
        continue;
      }
      const key = `${job.name}\0${job.started_at}\0${job.completed_at}`;
      if (counted.has(key)) continue;
      counted.add(key);
      runnerSeconds += (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
    }
    const finished = jobs.flatMap((job) =>
      job.completed_at ? [Date.parse(job.completed_at)] : [],
    );
    attempts.push({
      runId: run.id,
      attempt: number,
      workflowId: run.workflow_id,
      workflowName: run.name,
      workflowPath: run.path,
      event: run.event,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      headRepository: run.head_repository?.full_name ?? null,
      scope: scopeOf(run, context.defaultBranch),
      actor: run.actor?.login ?? null,
      actorKind: actorKind(run.actor),
      triggeringActor: run.triggering_actor?.login ?? null,
      status: run.status,
      conclusion: run.conclusion,
      state,
      createdAt: run.created_at,
      runStartedAt: run.run_started_at,
      completedAt:
        finished.length > 0 ? new Date(Math.max(...finished)).toISOString() : run.updated_at,
      url: run.html_url,
      pullRequest: run.pull_requests?.[0]?.number ?? null,
      inScope,
      jobsAvailable,
      runnerSeconds,
      failure:
        state === "failure" && jobsAvailable
          ? describeAttemptFailure(context, run, number, jobs)
          : null,
    });
  }
  return attempts;
}
