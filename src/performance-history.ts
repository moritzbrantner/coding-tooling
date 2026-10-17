import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  type ControlledHistory,
  parsePerformanceContract,
  performanceContractPath,
} from "./performance-contract.ts";

export const performanceHistorySchemaVersion = "coding-tooling/performance-history/v1";
/** The runtime-profiler `score` history document written to a data-only branch. */
export const scoreHistorySchemaVersion = "runtime-profiler/score-history/v1";

export type HistoryLatest = {
  commit: string | null;
  parentCommit: string | null;
  timestamp: string | null;
  classification: "comparable" | "incomparable";
  score: number | null;
  rating: string | null;
  averageChangePercent: number | null;
  reason?: string | null;
};

export type HistoryScenario = {
  id: string;
  branch: string;
  path: string;
  /** runtime-profiler `scenario_id` filter. */
  scenario: string;
  status: "available" | "unavailable";
  reason?: string;
  /** Git ref the document was read from, when one was found. */
  ref?: string;
  entries: number;
  latest?: HistoryLatest;
};

export type PerformanceHistoryData = {
  schemaVersion: typeof performanceHistorySchemaVersion;
  root: string;
  contract: { path: string };
  scenarios: HistoryScenario[];
  limitations: string[];
};

export type HistoryEntry = Record<string, unknown>;
export type HistoryDocument =
  | { ref: string; entries: HistoryEntry[] }
  | { ref?: string; reason: string };

function git(root: string, args: string[]) {
  return spawnSync("git", ["--no-replace-objects", "-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Read a history document from git objects only: origin's branch first, then the local branch. */
export function readHistoryDocument(root: string, branch: string, path: string): HistoryDocument {
  const refs = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`];
  const ref = refs.find(
    (candidate) =>
      git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).status === 0,
  );
  if (ref === undefined)
    return { reason: `history branch ${branch} not found (tried ${refs.join(", ")})` };
  const shown = git(root, ["show", `${ref}:${path}`]);
  if (shown.status !== 0) return { ref, reason: `history file ${path} is missing on ${ref}` };
  let document: unknown;
  try {
    document = JSON.parse(shown.stdout);
  } catch (error) {
    return {
      ref,
      reason: `history file ${path} on ${ref} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const value =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {};
  if (value.schema_version !== scoreHistorySchemaVersion)
    return {
      ref,
      reason: `history file ${path} on ${ref} has unsupported schema_version ${JSON.stringify(value.schema_version ?? null)} (expected ${scoreHistorySchemaVersion})`,
    };
  if (!Array.isArray(value.entries))
    return { ref, reason: `history file ${path} on ${ref} has no entries array` };
  return {
    ref,
    entries: value.entries.filter(
      (entry): entry is HistoryEntry =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    ),
  };
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const time = (entry: HistoryEntry) => {
  const parsed = Date.parse(String(entry.timestamp));
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** Classify an entry only by its own `status`; runtime-profiler score already decided comparability. */
function latestOf(entry: HistoryEntry): HistoryLatest {
  const comparable = entry.status === "scored";
  return {
    commit: text(entry.commit),
    parentCommit: text(entry.parent_commit),
    timestamp: text(entry.timestamp),
    classification: comparable ? "comparable" : "incomparable",
    score: number(entry.score),
    rating: text(entry.rating),
    averageChangePercent: number(entry.average_change_percent),
    ...(comparable ? {} : { reason: text(entry.reason) }),
  };
}

/**
 * Entries that belong to the declared scenario filter. `scenario_id: null` is what runtime-profiler
 * records when scoring was unavailable, so such an entry belongs to every filter on this history
 * and a failed run still surfaces as the newest entry.
 */
export function matchingEntries(
  declared: ControlledHistory,
  entries: HistoryEntry[],
): HistoryEntry[] {
  return entries.filter(
    (entry) => entry.scenario_id === declared.scenario || entry.scenario_id === null,
  );
}

/** Newest by timestamp; on a tie the later-appended entry wins. */
export function newestEntry(entries: HistoryEntry[]): HistoryEntry | undefined {
  if (entries.length === 0) return undefined;
  return entries.reduce((best, entry) => (time(entry) >= time(best) ? entry : best));
}

function scenarioHistory(declared: ControlledHistory, document: HistoryDocument): HistoryScenario {
  const base = {
    id: declared.id,
    branch: declared.branch,
    path: declared.path,
    scenario: declared.scenario,
    ...(document.ref === undefined ? {} : { ref: document.ref }),
  };
  if ("reason" in document)
    return { ...base, status: "unavailable", reason: document.reason, entries: 0 };
  const matching = matchingEntries(declared, document.entries);
  if (matching.length === 0)
    return {
      ...base,
      status: "unavailable",
      reason: `no history entry has scenario_id ${declared.scenario}`,
      entries: 0,
    };
  const newest = newestEntry(matching)!;
  return { ...base, status: "available", entries: matching.length, latest: latestOf(newest) };
}

/**
 * Read-only report of controlled performance history (#158). Each contract scenario with a
 * `controlled.history` block is resolved against a runtime-profiler score-history document on a
 * data-only branch. Comparison itself is runtime-profiler's; regressions are informational.
 */
export function performanceHistory(root: string): ResultEnvelope<PerformanceHistoryData> {
  const resolvedRoot = resolve(root);
  const diagnostics: Diagnostic[] = [];
  const data: PerformanceHistoryData = {
    schemaVersion: performanceHistorySchemaVersion,
    root: resolvedRoot,
    contract: { path: performanceContractPath },
    scenarios: [],
    limitations: [
      "History is read from git objects (origin's branch, then the local branch), never the working tree; fetch the branch to see the newest entries.",
      "Comparability is decided by `runtime-profiler score` when it writes an entry; coding-tooling does not compare fingerprints or digests and classifies an entry only by its own status.",
      "A score below 100 is informational; historical ratchets are not gates.",
    ],
  };
  const result = (status: "passed" | "failed" | "unavailable") => ({
    schemaVersion: 1 as const,
    operation: "performance-history" as const,
    status,
    // Fixed so identical history produces byte-identical reports.
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
  let controlled: ControlledHistory[];
  try {
    controlled = parsePerformanceContract(
      JSON.parse(readFileSync(contractFile, "utf8")),
    ).controlled;
  } catch (error) {
    diagnostics.push({
      code: "performance-contract-invalid",
      message: `Invalid performance contract: ${error instanceof Error ? error.message : String(error)}`,
      path: performanceContractPath,
    });
    return result("failed");
  }

  const documents = new Map<string, HistoryDocument>();
  for (const declared of controlled) {
    const key = JSON.stringify([declared.branch, declared.path]);
    let document = documents.get(key);
    if (!document) {
      document = readHistoryDocument(resolvedRoot, declared.branch, declared.path);
      documents.set(key, document);
    }
    const scenario = scenarioHistory(declared, document);
    data.scenarios.push(scenario);
    if (scenario.status === "unavailable")
      diagnostics.push({
        code: "performance-history-unavailable",
        message: `Controlled history for scenario ${scenario.id} is unavailable: ${scenario.reason}.`,
        path: performanceContractPath,
      });
  }
  return result(
    data.scenarios.some((value) => value.status === "unavailable") ? "unavailable" : "passed",
  );
}
