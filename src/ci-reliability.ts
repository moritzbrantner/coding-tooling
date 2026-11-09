import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  attributeFailure,
  failureCategories,
  findAnnotation,
  parseFailureAnnotations,
  type Attribution,
  type BaseOutcome,
  type FailureAnnotation,
  type FailureCategory,
  type FailureDescription,
  type RetryOutcome,
} from "./ci-reliability-attribution.ts";
import {
  CoverageTally,
  collectAttempts,
  ghLog,
  ghText,
  listRuns,
  type ApiRun,
  type Attempt,
  type CollectContext,
  type CoverageWarning,
  type GitHubTextApi,
} from "./ci-reliability-collect.ts";
import { resolveRepo, stats, type DurationStats, type GitHubApi } from "./ci-durations.ts";
import type { Diagnostic, ResultEnvelope } from "./model.ts";

export const ciReliabilitySchemaVersion = "coding-tooling/ci-reliability/v1";

export type CiReliabilityOptions = {
  repo?: string;
  workflow?: string;
  /** Window length ending today (default 14); ignored when `since` is set. */
  days?: number;
  /** Inclusive `YYYY-MM-DD` window bounds, for reproducing a report later. */
  since?: string;
  until?: string;
  /** Newest runs to read (default 300). */
  maxRuns?: number;
  /** Report filters; default-branch runs are still read for base comparison. */
  branch?: string;
  event?: string;
  annotationsPath?: string;
  /** Maximum ranked causes and failure rows in the table (default 10). */
  limit?: number;
  now?: Date;
  api?: GitHubApi;
  text?: GitHubTextApi;
};

export type FirstAttemptRate = {
  successes: number;
  denominator: number;
  rate: number | null;
};

export type FirstAttemptReport = FirstAttemptRate & {
  excluded: {
    pending: number;
    cancelled: number;
    cancelledSuperseded: number;
    skipped: number;
    notApplicable: number;
    firstAttemptUnavailable: number;
  };
  segments: ({ scope: Attempt["scope"]; actorKind: Attempt["actorKind"] } & FirstAttemptRate)[];
};

export type RedHeadState = "recovered" | "still-red" | "superseded" | "pending";

export type RedHead = {
  workflow: string;
  event: string;
  headSha: string;
  pullRequest: number | null;
  state: RedHeadState;
  firstRedRunId: number;
  firstRedAttempt: number;
  firstRedAt: string;
  greenRunId: number | null;
  greenAt: string | null;
  secondsToGreen: number | null;
};

export type RedPullRequest = {
  workflow: string;
  pullRequest: number;
  firstRedSha: string;
  firstRedRunId: number;
  firstRedAt: string;
  /** Null while no head on this pull request has passed since the first failure. */
  greenSha: string | null;
  greenRunId: number | null;
  greenAt: string | null;
  headsCrossed: number;
  secondsToGreen: number | null;
};

export type FailureIncident = {
  workflow: string;
  workflowPath: string;
  event: string;
  scope: Attempt["scope"];
  headSha: string;
  headBranch: string | null;
  pullRequest: number | null;
  actorKind: Attempt["actorKind"];
  firstFailingJob: FailureDescription["job"];
  firstFailingStep: FailureDescription["step"];
  zeroStep: boolean;
  fingerprint: FailureDescription["fingerprint"];
  signal: FailureDescription["signal"];
  attempts: {
    runId: number;
    attempt: number;
    conclusion: string | null;
    url: string;
    createdAt: string;
    startedAt: string;
    completedAt: string;
    runnerSeconds: number;
  }[];
  attribution: Attribution;
};

export type RecurringCause = {
  category: FailureCategory;
  fingerprint: string;
  label: string;
  incidents: number;
  wastedRunnerSeconds: number;
  redToGreenSeconds: number;
  recoveredHeads: number;
  runIds: number[];
};

export type MergedPullRequestRunnerTime = {
  pullRequest: number;
  mergedAt: string;
  runnerSeconds: number;
  attempts: number;
};

export type CiReliabilityData = {
  schemaVersion: typeof ciReliabilitySchemaVersion;
  repo: string;
  defaultBranch: string | null;
  window: { since: string; until: string | null };
  filters: { workflow: string | null; branch: string | null; event: string | null };
  firstAttempt: FirstAttemptReport;
  redToGreen: {
    perHead: {
      seconds: DurationStats;
      samples: number;
      stillRed: number;
      supersededWithoutGreen: number;
      pending: number;
    };
    perPullRequest: { seconds: DurationStats; samples: number; stillRed: number };
    heads: RedHead[];
    pullRequests: RedPullRequest[];
  };
  runnerTime: {
    label: "runner time, not billing";
    perMergedPullRequest: DurationStats | null;
    totalSeconds: number;
    mergedPullRequests: number;
    excluded: { openedBeforeCoverage: number; noRunsSampled: number; missingJobs: number };
    pullRequests: MergedPullRequestRunnerTime[];
  };
  attribution: {
    incidents: number;
    confirmed: Record<FailureCategory, number>;
    hypotheses: Record<FailureCategory, number>;
    unclassified: number;
  };
  recurringConfirmedCauses: RecurringCause[];
  failures: FailureIncident[];
  coverage: {
    runsRead: number;
    runsInScope: number;
    attempts: number;
    failedAttempts: number;
    failedAttemptsWithoutJobs: number;
    warnings: CoverageWarning[];
  };
  limitations: string[];
};

type ApiPull = {
  number: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  head: { ref: string; repo?: { full_name: string } | null };
};

type HeadGroup = { key: string; attempts: Attempt[]; superseded: boolean };

const time = (value: string) => Date.parse(value);
const secondsBetween = (from: string, to: string) => (time(to) - time(from)) / 1000;
const zeroCounts = () =>
  Object.fromEntries(failureCategories.map((category) => [category, 0])) as Record<
    FailureCategory,
    number
  >;

function listClosedPulls(
  context: CollectContext,
  since: string,
): { pulls: ApiPull[]; complete: boolean } | undefined {
  const pulls: ApiPull[] = [];
  try {
    for (let page = 1; page <= 10; page += 1) {
      const listed = context.api(
        `repos/${context.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
      ) as ApiPull[];
      pulls.push(...listed);
      const oldest = listed.at(-1);
      if (listed.length < 100 || (oldest && time(oldest.updated_at) < time(since)))
        return { pulls, complete: true };
    }
    return { pulls, complete: false };
  } catch (error) {
    context.tally.add(
      "ci-reliability-pull-metadata-unavailable",
      "Pull request merge metadata could not be read",
      (error as Error).message,
    );
    return undefined;
  }
}

/** Fork runs carry no pull request reference, so they match by head repository and branch. */
function assignPullRequests(attempts: Attempt[], pulls: ApiPull[]): void {
  for (const attempt of attempts) {
    if (attempt.scope === "default-branch") {
      attempt.pullRequest = null;
      continue;
    }
    if (attempt.pullRequest !== null) continue;
    const pull = pulls.find(
      (candidate) =>
        candidate.head.ref === attempt.headBranch &&
        (candidate.head.repo?.full_name ?? null) === attempt.headRepository &&
        time(attempt.createdAt) >= time(candidate.created_at) &&
        time(attempt.createdAt) <= time(candidate.merged_at ?? candidate.closed_at ?? ""),
    );
    if (pull) attempt.pullRequest = pull.number;
  }
}

function groupHeads(attempts: Attempt[]): HeadGroup[] {
  const groups = new Map<string, HeadGroup>();
  for (const attempt of attempts) {
    const key = `${attempt.workflowId}\0${attempt.event}\0${attempt.headSha}`;
    const group = groups.get(key) ?? { key, attempts: [], superseded: false };
    group.attempts.push(attempt);
    groups.set(key, group);
  }
  const lines = new Map<string, HeadGroup[]>();
  for (const group of groups.values()) {
    group.attempts.sort(
      (left, right) =>
        // The list endpoint gives every attempt the first attempt's `created_at`.
        time(left.runStartedAt) - time(right.runStartedAt) ||
        left.runId - right.runId ||
        left.attempt - right.attempt,
    );
    const first = group.attempts[0]!;
    const line = `${first.workflowId}\0${first.event}\0${first.pullRequest ?? first.headBranch}`;
    lines.set(line, [...(lines.get(line) ?? []), group]);
  }
  for (const line of lines.values()) {
    line.sort(
      (left, right) => time(left.attempts[0]!.runStartedAt) - time(right.attempts[0]!.runStartedAt),
    );
    for (const group of line.slice(0, -1)) group.superseded = true;
  }
  return [...groups.values()];
}

const rate = (successes: number, denominator: number): FirstAttemptRate => ({
  successes,
  denominator,
  rate: denominator === 0 ? null : successes / denominator,
});

function firstAttemptReport(groups: HeadGroup[]): FirstAttemptReport {
  const excluded = {
    pending: 0,
    cancelled: 0,
    cancelledSuperseded: 0,
    skipped: 0,
    notApplicable: 0,
    firstAttemptUnavailable: 0,
  };
  let successes = 0;
  let denominator = 0;
  const segments = new Map<string, FirstAttemptReport["segments"][number]>();
  for (const group of groups) {
    const first = group.attempts[0]!;
    if (first.attempt !== 1) excluded.firstAttemptUnavailable += 1;
    else if (first.state === "pending") excluded.pending += 1;
    else if (first.state === "cancelled") {
      if (group.superseded) excluded.cancelledSuperseded += 1;
      else excluded.cancelled += 1;
    } else if (first.state === "skipped") excluded.skipped += 1;
    else if (first.state === "not-applicable") excluded.notApplicable += 1;
    else {
      const passed = first.state === "success" ? 1 : 0;
      successes += passed;
      denominator += 1;
      const key = `${first.scope}\0${first.actorKind}`;
      const segment = segments.get(key) ?? {
        scope: first.scope,
        actorKind: first.actorKind,
        ...rate(0, 0),
      };
      segments.set(key, {
        ...segment,
        ...rate(segment.successes + passed, segment.denominator + 1),
      });
    }
  }
  return {
    ...rate(successes, denominator),
    excluded,
    segments: [...segments.values()].sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) || left.actorKind.localeCompare(right.actorKind),
    ),
  };
}

function redHead(group: HeadGroup): RedHead | undefined {
  const firstRedIndex = group.attempts.findIndex((attempt) => attempt.state === "failure");
  if (firstRedIndex < 0) return undefined;
  const red = group.attempts[firstRedIndex]!;
  const later = group.attempts.slice(firstRedIndex + 1);
  const green = later.find((attempt) => attempt.state === "success");
  const state: RedHeadState = green
    ? "recovered"
    : later.some((attempt) => attempt.state === "pending")
      ? "pending"
      : group.superseded
        ? "superseded"
        : "still-red";
  return {
    workflow: red.workflowName,
    event: red.event,
    headSha: red.headSha,
    pullRequest: red.pullRequest,
    state,
    firstRedRunId: red.runId,
    firstRedAttempt: red.attempt,
    firstRedAt: red.completedAt,
    greenRunId: green?.runId ?? null,
    greenAt: green?.completedAt ?? null,
    secondsToGreen: green ? secondsBetween(red.completedAt, green.completedAt) : null,
  };
}

/** The pull-request view spans heads on purpose and names both SHAs; per-head rows never do. */
function redPullRequests(groups: HeadGroup[]): RedPullRequest[] {
  const byLine = new Map<string, Attempt[]>();
  for (const attempt of groups.flatMap((group) => group.attempts)) {
    if (attempt.pullRequest === null) continue;
    const key = `${attempt.workflowId}\0${attempt.pullRequest}`;
    byLine.set(key, [...(byLine.get(key) ?? []), attempt]);
  }
  const rows: RedPullRequest[] = [];
  for (const attempts of byLine.values()) {
    attempts.sort((left, right) => time(left.completedAt) - time(right.completedAt));
    const redIndex = attempts.findIndex((attempt) => attempt.state === "failure");
    if (redIndex < 0) continue;
    const red = attempts[redIndex]!;
    const green = attempts.slice(redIndex + 1).find((attempt) => attempt.state === "success");
    const crossed = attempts.slice(redIndex, green ? attempts.indexOf(green) + 1 : undefined);
    rows.push({
      workflow: red.workflowName,
      pullRequest: red.pullRequest!,
      firstRedSha: red.headSha,
      firstRedRunId: red.runId,
      firstRedAt: red.completedAt,
      greenSha: green?.headSha ?? null,
      greenRunId: green?.runId ?? null,
      greenAt: green?.completedAt ?? null,
      headsCrossed: new Set(crossed.map((attempt) => attempt.headSha)).size,
      secondsToGreen: green ? secondsBetween(red.completedAt, green.completedAt) : null,
    });
  }
  return rows.sort((left, right) => left.pullRequest - right.pullRequest);
}

function compareBase(
  first: Attempt,
  fingerprint: string,
  baseAttempts: Attempt[],
  defaultBranch: string,
): BaseOutcome {
  if (first.scope !== "pull-request")
    return { state: "unavailable", reason: `Only pull request heads compare to ${defaultBranch}.` };
  const base = baseAttempts
    .filter(
      (attempt) =>
        attempt.workflowId === first.workflowId &&
        (attempt.state === "success" || attempt.state === "failure") &&
        time(attempt.completedAt) <= time(first.createdAt),
    )
    .sort((left, right) => time(right.completedAt) - time(left.completedAt))[0];
  if (!base)
    return {
      state: "unavailable",
      reason: `No completed ${defaultBranch} run of this workflow preceded this head in the window.`,
    };
  if (base.state === "success") return { state: "green", runId: base.runId };
  if (!base.failure)
    return {
      state: "unavailable",
      reason: `Jobs for ${defaultBranch} run ${base.runId} are missing.`,
    };
  if (base.failure.fingerprint.id !== fingerprint)
    return { state: "red-different", runId: base.runId };
  // A shared job and step name with no failure text does not show the same failure.
  return base.failure.signal
    ? { state: "red-same", runId: base.runId }
    : {
        state: "unavailable",
        reason: `Neither this head nor ${defaultBranch} run ${base.runId} has failure text to compare.`,
      };
}

function retryOutcome(group: HeadGroup, incident: Attempt[]): RetryOutcome {
  const later = group.attempts.slice(group.attempts.indexOf(incident[0]!) + 1);
  const green = later.filter((attempt) => attempt.state === "success");
  if (green.length > 0)
    return { state: "green", runIds: [...new Set(green.map((attempt) => attempt.runId))] };
  if (incident.length > 1)
    return {
      state: "reproduced",
      runIds: [...new Set(incident.slice(1).map((attempt) => attempt.runId))],
    };
  return { state: "none" };
}

function failureIncidents(
  groups: HeadGroup[],
  baseAttempts: Attempt[],
  annotations: FailureAnnotation[],
  defaultBranch: string,
): FailureIncident[] {
  const incidents: FailureIncident[] = [];
  for (const group of groups) {
    const byFingerprint = new Map<string, Attempt[]>();
    for (const attempt of group.attempts) {
      if (!attempt.failure) continue;
      const id = attempt.failure.fingerprint.id;
      byFingerprint.set(id, [...(byFingerprint.get(id) ?? []), attempt]);
    }
    for (const [fingerprint, attempts] of byFingerprint) {
      const first = attempts[0]!;
      const description = first.failure!;
      incidents.push({
        workflow: first.workflowName,
        workflowPath: first.workflowPath,
        event: first.event,
        scope: first.scope,
        headSha: first.headSha,
        headBranch: first.headBranch,
        pullRequest: first.pullRequest,
        actorKind: first.actorKind,
        firstFailingJob: description.job,
        firstFailingStep: description.step,
        zeroStep: description.zeroStep,
        fingerprint: description.fingerprint,
        signal: description.signal,
        attempts: attempts.map((attempt) => ({
          runId: attempt.runId,
          attempt: attempt.attempt,
          conclusion: attempt.conclusion,
          url: attempt.failure!.job?.url ?? attempt.url,
          createdAt: attempt.createdAt,
          startedAt: attempt.runStartedAt,
          completedAt: attempt.completedAt,
          runnerSeconds: attempt.runnerSeconds,
        })),
        attribution: attributeFailure({
          description,
          retry: retryOutcome(group, attempts),
          base: compareBase(first, fingerprint, baseAttempts, defaultBranch),
          annotation: findAnnotation(annotations, fingerprint, attempts),
        }),
      });
    }
  }
  return incidents.sort(
    (left, right) =>
      time(right.attempts[0]!.completedAt) - time(left.attempts[0]!.completedAt) ||
      left.fingerprint.id.localeCompare(right.fingerprint.id),
  );
}

function rankConfirmedCauses(
  incidents: FailureIncident[],
  heads: RedHead[],
  limit: number,
): RecurringCause[] {
  const causes = new Map<string, RecurringCause>();
  for (const incident of incidents) {
    if (incident.attribution.status !== "confirmed") continue;
    const key = `${incident.attribution.category}\0${incident.fingerprint.id}`;
    const cause = causes.get(key) ?? {
      category: incident.attribution.category,
      fingerprint: incident.fingerprint.id,
      label: incident.fingerprint.text,
      incidents: 0,
      wastedRunnerSeconds: 0,
      redToGreenSeconds: 0,
      recoveredHeads: 0,
      runIds: [],
    };
    cause.incidents += 1;
    for (const attempt of incident.attempts) {
      cause.wastedRunnerSeconds += attempt.runnerSeconds;
      if (!cause.runIds.includes(attempt.runId)) cause.runIds.push(attempt.runId);
    }
    const first = incident.attempts[0]!;
    const head = heads.find(
      (row) => row.firstRedRunId === first.runId && row.firstRedAttempt === first.attempt,
    );
    if (head?.secondsToGreen != null) {
      cause.redToGreenSeconds += head.secondsToGreen;
      cause.recoveredHeads += 1;
    }
    causes.set(key, cause);
  }
  return [...causes.values()]
    .sort(
      (left, right) =>
        right.wastedRunnerSeconds - left.wastedRunnerSeconds ||
        right.redToGreenSeconds - left.redToGreenSeconds ||
        left.fingerprint.localeCompare(right.fingerprint),
    )
    .slice(0, limit);
}

function runnerTimeReport(
  scoped: Attempt[],
  pulls: ApiPull[] | undefined,
  coveredFrom: string,
  until: string | null,
): CiReliabilityData["runnerTime"] {
  const report: CiReliabilityData["runnerTime"] = {
    label: "runner time, not billing",
    perMergedPullRequest: null,
    totalSeconds: 0,
    mergedPullRequests: 0,
    excluded: { openedBeforeCoverage: 0, noRunsSampled: 0, missingJobs: 0 },
    pullRequests: [],
  };
  if (!pulls) return report;
  for (const pull of pulls) {
    if (!pull.merged_at || time(pull.merged_at) < time(coveredFrom)) continue;
    if (until && pull.merged_at.slice(0, 10) > until) continue;
    if (time(pull.created_at) < time(coveredFrom)) {
      report.excluded.openedBeforeCoverage += 1;
      continue;
    }
    const attempts = scoped.filter((attempt) => attempt.pullRequest === pull.number);
    if (attempts.length === 0) report.excluded.noRunsSampled += 1;
    else if (attempts.some((attempt) => attempt.state !== "pending" && !attempt.jobsAvailable))
      report.excluded.missingJobs += 1;
    else
      report.pullRequests.push({
        pullRequest: pull.number,
        mergedAt: pull.merged_at,
        runnerSeconds: attempts.reduce((sum, attempt) => sum + attempt.runnerSeconds, 0),
        attempts: attempts.length,
      });
  }
  report.pullRequests.sort((left, right) => left.pullRequest - right.pullRequest);
  report.mergedPullRequests = report.pullRequests.length;
  report.totalSeconds = report.pullRequests.reduce((sum, row) => sum + row.runnerSeconds, 0);
  if (report.mergedPullRequests > 0)
    report.perMergedPullRequest = stats(report.pullRequests.map((row) => row.runnerSeconds));
  return report;
}

function loadAnnotations(root: string, path: string | undefined): FailureAnnotation[] {
  return path === undefined
    ? []
    : parseFailureAnnotations(JSON.parse(readFileSync(resolve(root, path), "utf8")));
}

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

function emptyData(options: CiReliabilityOptions, since: string): CiReliabilityData {
  return {
    schemaVersion: ciReliabilitySchemaVersion,
    repo: options.repo ?? "",
    defaultBranch: null,
    window: { since, until: options.until ?? null },
    filters: {
      workflow: options.workflow ?? null,
      branch: options.branch ?? null,
      event: options.event ?? null,
    },
    firstAttempt: firstAttemptReport([]),
    redToGreen: {
      perHead: {
        seconds: stats([]),
        samples: 0,
        stillRed: 0,
        supersededWithoutGreen: 0,
        pending: 0,
      },
      perPullRequest: { seconds: stats([]), samples: 0, stillRed: 0 },
      heads: [],
      pullRequests: [],
    },
    runnerTime: runnerTimeReport([], undefined, since, null),
    attribution: {
      incidents: 0,
      confirmed: zeroCounts(),
      hypotheses: zeroCounts(),
      unclassified: 0,
    },
    recurringConfirmedCauses: [],
    failures: [],
    coverage: {
      runsRead: 0,
      runsInScope: 0,
      attempts: 0,
      failedAttempts: 0,
      failedAttemptsWithoutJobs: 0,
      warnings: [],
    },
    limitations: [
      "Evidence only: this report is not a gate, and a green rerun does not waive a failed deterministic gate.",
      "Results describe the sampled window of one repository; they are not a fleet-wide failure rate.",
      "A category is a hypothesis until a same-head retry, base comparison, platform report or maintainer annotation supports it; even a confirmed category attributes this failure and does not prove the code free of defects.",
      "Base comparison uses the latest completed default-branch run of the same workflow before the head started, not the pull request's merge base.",
      "Runner time is job execution timestamps summed across attempts; it is not billed minutes.",
    ],
  };
}

/**
 * Read-only CI reliability evidence over a time window: first-attempt success, first-red-to-green
 * delay, runner time per merged pull request, and failure attribution by exact head.
 */
export function ciReliability(
  root: string,
  options: CiReliabilityOptions = {},
): ResultEnvelope<CiReliabilityData> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const since =
    options.since ?? dateOnly(new Date(now.getTime() - (options.days ?? 14) * 86_400_000));
  const data = emptyData(options, since);
  const diagnostics: Diagnostic[] = [];
  const envelope = (status: "passed" | "unavailable"): ResultEnvelope<CiReliabilityData> => ({
    schemaVersion: 1,
    operation: "ci-reliability",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  });
  const unavailable = (code: string, message: string) => {
    diagnostics.push({ code, message });
    return envelope("unavailable");
  };
  let annotations: FailureAnnotation[];
  try {
    annotations = loadAnnotations(root, options.annotationsPath);
  } catch (error) {
    return unavailable(
      "ci-reliability-annotations-invalid",
      `Annotations ${options.annotationsPath} are invalid: ${(error as Error).message}`,
    );
  }
  const repo = options.repo ?? resolveRepo(root);
  if (!repo)
    return unavailable(
      "ci-reliability-repo-unknown",
      "Could not resolve the GitHub repository; pass --repo owner/name.",
    );
  data.repo = repo;
  // A page of 100 full run objects exceeds the default spawn buffer `ghApi` uses.
  const api = options.api ?? ((path: string) => JSON.parse(ghText(path)) as unknown);
  const tally = new CoverageTally();
  let listed: { runs: ApiRun[]; truncated: boolean };
  let defaultBranch: string;
  try {
    defaultBranch = (api(`repos/${repo}`) as { default_branch: string }).default_branch;
    listed = listRuns({ repo, api }, data.window, options.workflow, options.maxRuns ?? 300);
  } catch (error) {
    return unavailable(
      "ci-reliability-gh-unavailable",
      `gh api failed: ${(error as Error).message}`,
    );
  }
  data.defaultBranch = defaultBranch;
  const context: CollectContext = {
    repo,
    defaultBranch,
    api,
    text: options.text ?? ghLog,
    tally,
  };
  const inScope = (run: ApiRun) =>
    (options.branch === undefined || run.head_branch === options.branch) &&
    (options.event === undefined || run.event === options.event);
  const attempts = listed.runs.flatMap((run) => collectAttempts(context, run, inScope(run)));
  const scoped = attempts.filter((attempt) => attempt.inScope);
  const oldest = listed.runs.at(-1)?.created_at;
  const coveredFrom = listed.truncated && oldest ? oldest : since;
  if (listed.truncated)
    tally.add(
      "ci-reliability-history-truncated",
      "History was truncated before the window start; raise --max-runs or narrow the window",
      `oldest run read ${oldest ?? "none"}`,
    );
  const pulls = listClosedPulls(context, coveredFrom);
  if (pulls && !pulls.complete)
    tally.add(
      "ci-reliability-pull-metadata-truncated",
      "Closed pull request history was truncated",
      `oldest read ${pulls.pulls.at(-1)?.updated_at ?? "none"}`,
    );
  assignPullRequests(attempts, pulls?.pulls ?? []);
  const groups = groupHeads(scoped);
  const baseAttempts = attempts.filter(
    (attempt) => attempt.scope === "default-branch" && attempt.event !== "workflow_dispatch",
  );
  data.firstAttempt = firstAttemptReport(groups);
  if (data.firstAttempt.denominator === 0)
    tally.add(
      "ci-reliability-no-completed-attempts",
      "Heads with a completed, applicable first attempt",
      `window from ${since}`,
    );
  const heads = groups.flatMap((group) => redHead(group) ?? []);
  const recovered = heads.flatMap((head) => head.secondsToGreen ?? []);
  const pullRows = redPullRequests(groups);
  const pullRecovered = pullRows.flatMap((row) => row.secondsToGreen ?? []);
  const count = (state: RedHeadState) => heads.filter((head) => head.state === state).length;
  data.redToGreen = {
    perHead: {
      seconds: stats(recovered),
      samples: recovered.length,
      stillRed: count("still-red"),
      supersededWithoutGreen: count("superseded"),
      pending: count("pending"),
    },
    perPullRequest: {
      seconds: stats(pullRecovered),
      samples: pullRecovered.length,
      stillRed: pullRows.length - pullRecovered.length,
    },
    heads,
    pullRequests: pullRows,
  };
  data.runnerTime = runnerTimeReport(scoped, pulls?.pulls, coveredFrom, options.until ?? null);
  data.failures = failureIncidents(groups, baseAttempts, annotations, defaultBranch);
  data.attribution.incidents = data.failures.length;
  for (const { attribution } of data.failures) {
    if (attribution.status === "confirmed") data.attribution.confirmed[attribution.category] += 1;
    else if (attribution.status === "hypothesis")
      data.attribution.hypotheses[attribution.hypothesis!] += 1;
    else data.attribution.unclassified += 1;
  }
  data.recurringConfirmedCauses = rankConfirmedCauses(data.failures, heads, options.limit ?? 10);
  const failed = scoped.filter((attempt) => attempt.state === "failure");
  data.coverage = {
    runsRead: listed.runs.length,
    runsInScope: listed.runs.filter(inScope).length,
    attempts: scoped.length,
    failedAttempts: failed.length,
    failedAttemptsWithoutJobs: failed.filter((attempt) => !attempt.failure).length,
    warnings: tally.warnings(),
  };
  diagnostics.push(...data.coverage.warnings.map(({ code, message }) => ({ code, message })));
  return envelope("passed");
}
