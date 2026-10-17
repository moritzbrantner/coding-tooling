import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  type ControlledHistory,
  type LatencyDeadline,
  type PerformanceContract,
  parsePerformanceContract,
  performanceContractPath,
  type WorkOperation,
} from "./performance-contract.ts";
import {
  type HistoryDocument,
  matchingEntries,
  newestEntry,
  readHistoryDocument,
} from "./performance-history.ts";
import { type WorkComplexityData, workComplexityEvidence } from "./work-complexity.ts";

export const performanceAcceptanceSchemaVersion = "coding-tooling/performance-acceptance/v1";
/** The runtime-profiler `score` document accepted by `--score`. */
export const scoreSchemaVersion = "runtime-profiler/score/v1";

export type VerdictState = "passed" | "failed" | "unavailable" | "not-declared" | "informational";
export type Verdict = { state: VerdictState; reason?: string } & Record<string, unknown>;
export type VerdictName =
  | "functional"
  | "work_growth"
  | "absolute_work"
  | "latency_deadline"
  | "historical_ratchet";
export type AcceptanceOperation = { id: string; verdicts: Record<VerdictName, Verdict> };
export type PerformanceAcceptanceData = {
  schemaVersion: typeof performanceAcceptanceSchemaVersion;
  root: string;
  contract: { path: string };
  operations: AcceptanceOperation[];
  limitations: string[];
};

type Source =
  | { kind: "history"; ref: string; path: string; commit: string | null; timestamp: string | null }
  | { kind: "score"; path: string };
/** The recorded statistic for one operation, or why it could not be read. */
type Timing =
  | { source: Source; unit: unknown; statistic: Record<string, unknown> }
  | { reason: string; source?: Source };

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Find `metric` / `statistic` in a runtime-profiler score or history-entry `metrics` array. */
function statisticOf(
  metrics: unknown,
  latency: LatencyDeadline,
  source: Source,
  where: string,
): Timing {
  const metric = (Array.isArray(metrics) ? metrics : [])
    .map(object)
    .find((value) => value?.id === latency.metric);
  if (!metric) return { source, reason: `${where} has no metric ${latency.metric}` };
  const statistic = (Array.isArray(metric.statistics) ? metric.statistics : [])
    .map(object)
    .find((value) => value?.statistic === latency.statistic);
  if (!statistic)
    return {
      source,
      reason: `${where} metric ${latency.metric} has no ${latency.statistic} statistic`,
    };
  return { source, unit: metric.unit, statistic };
}

function historyTiming(
  declared: ControlledHistory,
  document: HistoryDocument,
  latency: LatencyDeadline,
): Timing {
  if ("reason" in document) return { reason: document.reason };
  const entry = newestEntry(matchingEntries(declared, document.entries));
  if (!entry) return { reason: `no history entry has scenario_id ${declared.scenario}` };
  const commit = typeof entry.commit === "string" ? entry.commit : null;
  const source: Source = {
    kind: "history",
    ref: document.ref,
    path: declared.path,
    commit,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
  };
  const where = `the newest history entry (${commit ?? "unknown commit"})`;
  // Only the newest entry counts: an unscored newest entry never falls back to an older one.
  if (entry.status !== "scored")
    return {
      source,
      reason: `${where} is ${JSON.stringify(entry.status ?? null)}, not scored${typeof entry.reason === "string" ? `: ${entry.reason}` : ""}`,
    };
  return statisticOf(entry.metrics, latency, source, where);
}

function scoreTiming(path: string, declared: ControlledHistory, latency: LatencyDeadline): Timing {
  const source: Source = { kind: "score", path };
  if (!existsSync(path)) return { source, reason: `score file ${path} is missing` };
  let document: Record<string, unknown> | undefined;
  try {
    document = object(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return { source, reason: `score file ${path} is malformed JSON: ${message(error)}` };
  }
  if (document?.schema_version !== scoreSchemaVersion)
    return {
      source,
      reason: `score file ${path} has unsupported schema_version ${JSON.stringify(document?.schema_version ?? null)} (expected ${scoreSchemaVersion})`,
    };
  if (document.scenario_id !== declared.scenario)
    return {
      source,
      reason: `score file scenario_id ${JSON.stringify(document.scenario_id ?? null)} does not match ${declared.scenario}`,
    };
  return statisticOf(document.metrics, latency, source, `score file ${path}`);
}

function latencyVerdicts(
  latency: LatencyDeadline | null,
  timing: Timing | undefined,
): Pick<Record<VerdictName, Verdict>, "latency_deadline" | "historical_ratchet"> {
  if (latency === null || timing === undefined)
    return {
      latency_deadline: { state: "not-declared" },
      historical_ratchet: { state: "not-declared" },
    };
  const bound = { maxMs: latency.maxMs, metric: latency.metric, statistic: latency.statistic };
  const blocking = latency.ratchet === "blocking";
  if ("reason" in timing) {
    const unavailable = { reason: timing.reason, ...bound, source: timing.source ?? null };
    return {
      latency_deadline: { state: "unavailable", ...unavailable },
      historical_ratchet: {
        state: blocking ? "unavailable" : "informational",
        ...unavailable,
        changePercent: null,
      },
    };
  }
  const { source, unit, statistic } = timing;
  const value = finite(statistic.candidate);
  let deadline: Verdict;
  if (unit !== "ms")
    deadline = {
      state: "unavailable",
      reason: `metric ${latency.metric} unit is ${JSON.stringify(unit ?? null)}, not ms`,
    };
  else if (value === null)
    deadline = {
      state: "unavailable",
      reason: `statistic ${latency.statistic} of ${latency.metric} records no absolute candidate value`,
    };
  else deadline = { state: value <= latency.maxMs ? "passed" : "failed", value };

  // runtime-profiler convention: a negative change_percent (or a score below 100) is a regression.
  const changePercent = finite(statistic.change_percent);
  const score = finite(statistic.score);
  let ratchet: Verdict;
  if (changePercent === null && score === null)
    ratchet = {
      state: blocking ? "unavailable" : "informational",
      reason: `statistic ${latency.statistic} of ${latency.metric} records no change_percent or score`,
      changePercent: null,
    };
  else {
    const regression = changePercent === null ? score! < 100 : changePercent < 0;
    ratchet = {
      state: blocking ? (regression ? "failed" : "passed") : "informational",
      changePercent,
      regression,
    };
  }
  return {
    latency_deadline: { ...deadline, ...bound, source },
    historical_ratchet: { ...ratchet, statistic: latency.statistic, source },
  };
}

function workVerdict(
  operation: WorkOperation,
  kind: "growth" | "budget",
  work: ResultEnvelope<WorkComplexityData> | undefined,
): Verdict {
  const declared = operation.metrics.some((metric) =>
    kind === "growth" ? metric.growth.length > 0 : metric.budget !== null,
  );
  if (!declared || work === undefined) return { state: "not-declared" };
  if (work.status === "unavailable")
    return {
      state: "unavailable",
      reason:
        work.diagnostics.map((value) => value.message).join(" ") || "work evidence is unavailable",
    };
  const checks = (
    work.data.operations.find((value) => value.id === operation.id)?.checks ?? []
  ).filter((check) => check.kind === kind);
  if (checks.length === 0)
    return { state: "unavailable", reason: `no ${kind} check was evaluated for ${operation.id}` };
  return {
    state: checks.some((check) => check.state === "failed") ? "failed" : "passed",
    checks,
  };
}

/**
 * Combined acceptance report (#302): five verdicts per contract operation. `latency_deadline`
 * compares the newest recorded runtime-profiler statistic for the bound scenario (or a `--score`
 * file) with the declared `maxMs`; the work verdicts reuse `performance work`.
 */
export function performanceAcceptance(
  root: string,
  options: { evidence?: string; score?: string } = {},
): ResultEnvelope<PerformanceAcceptanceData> {
  const resolvedRoot = resolve(root);
  const diagnostics: Diagnostic[] = [];
  const data: PerformanceAcceptanceData = {
    schemaVersion: performanceAcceptanceSchemaVersion,
    root: resolvedRoot,
    contract: { path: performanceContractPath },
    operations: [],
    limitations: [
      "latency_deadline reads the recorded runtime-profiler statistic as-is; coding-tooling does not judge the environment, fingerprint or runner that produced it.",
      "Only the newest matching history entry (or the --score file) counts; there is no fallback to an older entry.",
      "historical_ratchet is informational unless the operation declares latency.ratchet: blocking.",
      "functional is not-declared: operations declare no correctness evidence yet.",
    ],
  };
  const result = (status: "passed" | "failed" | "unavailable") => ({
    schemaVersion: 1 as const,
    operation: "performance-acceptance" as const,
    status,
    // Fixed so identical inputs produce byte-identical reports.
    durationMs: 0,
    data,
    diagnostics,
  });

  const contractFile = resolve(resolvedRoot, performanceContractPath);
  if (!existsSync(contractFile)) {
    diagnostics.push({
      code: "performance-contract-missing",
      message: `Missing ${performanceContractPath}.`,
      path: performanceContractPath,
    });
    return result("failed");
  }
  let contract: PerformanceContract;
  try {
    contract = parsePerformanceContract(JSON.parse(readFileSync(contractFile, "utf8")));
  } catch (error) {
    diagnostics.push({
      code: "performance-contract-invalid",
      message: `Invalid performance contract: ${message(error)}`,
      path: performanceContractPath,
    });
    return result("failed");
  }

  const work = contract.operations.some((operation) => operation.metrics.length > 0)
    ? workComplexityEvidence(
        resolvedRoot,
        options.evidence === undefined ? {} : { evidence: options.evidence },
      )
    : undefined;
  if (work) diagnostics.push(...work.diagnostics);

  const documents = new Map<string, HistoryDocument>();
  for (const operation of contract.operations) {
    const latency = operation.latency;
    let timing: Timing | undefined;
    if (latency !== null) {
      const declared = contract.controlled.find((value) => value.id === latency.scenario)!;
      if (options.score !== undefined)
        timing = scoreTiming(resolve(options.score), declared, latency);
      else {
        const key = JSON.stringify([declared.branch, declared.path]);
        let document = documents.get(key);
        if (!document) {
          document = readHistoryDocument(resolvedRoot, declared.branch, declared.path);
          documents.set(key, document);
        }
        timing = historyTiming(declared, document, latency);
      }
    }
    const verdicts: Record<VerdictName, Verdict> = {
      functional: { state: "not-declared" },
      work_growth: workVerdict(operation, "growth", work),
      absolute_work: workVerdict(operation, "budget", work),
      ...latencyVerdicts(latency, timing),
    };
    if (verdicts.latency_deadline.state === "unavailable")
      diagnostics.push({
        code: "latency-deadline-unavailable",
        message: `Latency deadline for operation ${operation.id} is unavailable: ${verdicts.latency_deadline.reason}.`,
        path: performanceContractPath,
      });
    data.operations.push({ id: operation.id, verdicts });
  }

  // An informational ratchet is never `failed`, so every failed verdict is authoritative.
  const states = data.operations.flatMap((operation) =>
    Object.values(operation.verdicts).map((verdict) => verdict.state),
  );
  if (states.includes("failed")) return result("failed");
  if (states.includes("unavailable")) return result("unavailable");
  return result("passed");
}
