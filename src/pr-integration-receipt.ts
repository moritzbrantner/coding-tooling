import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import {
  pullRequestMergeEligibility,
  type PullRequestEligibilityDependencies,
} from "./pr-eligibility.ts";
import { type CommandResult, runCommand } from "./shared.ts";

export const PR_INTEGRATION_RECEIPT_VERSION = "coding-tooling/pr-integration-receipt/v1" as const;

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type CheckState = "passed" | "skipped" | "pending" | "failed" | "unavailable";

type RawPullRequest = {
  statusCheckRollup?: unknown;
};

type ClassifiedCheck = {
  name: string;
  state: CheckState;
};

function parseJson<T>(result: CommandResult): T | undefined {
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

function checkName(check: Record<string, unknown>): string {
  const value = check.name ?? check.context ?? check.__typename;
  return typeof value === "string" && value.trim() ? value.trim() : "unnamed-check";
}

export function classifyPullRequestChecks(value: unknown): ClassifiedCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((check) => {
      const name = checkName(check);
      const status = typeof check.status === "string" ? check.status.toUpperCase() : "";
      const conclusion =
        typeof check.conclusion === "string" ? check.conclusion.toUpperCase() : "";
      if (status && status !== "COMPLETED") return { name, state: "pending" as const };
      if (conclusion === "SKIPPED") return { name, state: "skipped" as const };
      if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") {
        return { name, state: "passed" as const };
      }
      if (conclusion) return { name, state: "failed" as const };
      const state = typeof check.state === "string" ? check.state.toUpperCase() : "";
      if (state === "SUCCESS") return { name, state: "passed" as const };
      if (state === "PENDING" || state === "EXPECTED") {
        return { name, state: "pending" as const };
      }
      if (state) return { name, state: "failed" as const };
      return { name, state: "unavailable" as const };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.state.localeCompare(right.state));
}

function requiredChecksFromEligibility(eligibility: ResultEnvelope<Record<string, unknown>>): string[] {
  const readiness = eligibility.data.repositoryReadiness;
  if (!readiness || typeof readiness !== "object") return [];
  const evidence = (readiness as Record<string, unknown>).evidence;
  if (!evidence || typeof evidence !== "object") return [];
  const required = (evidence as Record<string, unknown>).requiredChecks;
  return Array.isArray(required)
    ? [
        ...new Set(
          required.filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0,
          ),
        ),
      ].sort()
    : [];
}

function envelope(
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "pr-integration-receipt",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function pullRequestIntegrationReceipt(
  root: string,
  prNumber: number,
  options: { expectedHeadSha?: string; expectedBaseSha?: string } = {},
  dependencies: PullRequestEligibilityDependencies & { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const eligibility = pullRequestMergeEligibility(root, prNumber, options, dependencies);
  const data: Record<string, unknown> = {
    schemaVersion: PR_INTEGRATION_RECEIPT_VERSION,
    root,
    prNumber,
    eligibility: eligibility.data,
  };
  const diagnostics: Diagnostic[] = [...eligibility.diagnostics];

  const rawCommand = runner(
    "gh",
    ["pr", "view", String(prNumber), "--json", "statusCheckRollup"],
    root,
  );
  const raw = parseJson<RawPullRequest>(rawCommand);
  const checks = classifyPullRequestChecks(raw?.statusCheckRollup);
  if (!checks) {
    diagnostics.push({
      code: "integration-check-evidence-unavailable",
      message:
        rawCommand.stderr.trim() || rawCommand.error || "Could not classify attached pull-request checks",
    });
  }

  const requiredChecks = requiredChecksFromEligibility(eligibility);
  const checkByName = new Map((checks ?? []).map((check) => [check.name, check]));
  const receiptBlockers: string[] = [];
  for (const required of requiredChecks) {
    const check = checkByName.get(required);
    if (!check) receiptBlockers.push(`required-check-unavailable:${required}`);
    else if (check.state !== "passed") receiptBlockers.push(`required-check-${check.state}:${required}`);
  }
  if (!checks) receiptBlockers.push("check-classification-unavailable");

  const grouped = {
    passed: (checks ?? []).filter((check) => check.state === "passed").map((check) => check.name),
    skipped: (checks ?? []).filter((check) => check.state === "skipped").map((check) => check.name),
    pending: (checks ?? []).filter((check) => check.state === "pending").map((check) => check.name),
    failed: (checks ?? []).filter((check) => check.state === "failed").map((check) => check.name),
    unavailable: (checks ?? [])
      .filter((check) => check.state === "unavailable")
      .map((check) => check.name),
  };
  const performanceEvidenceChecks = (checks ?? [])
    .filter((check) => /benchmark|performance|profile/i.test(check.name))
    .map((check) => ({ name: check.name, state: check.state }));

  Object.assign(data, {
    headSha: eligibility.data.headSha ?? null,
    baseSha: eligibility.data.baseSha ?? null,
    expectedHeadSha: options.expectedHeadSha ?? eligibility.data.headSha ?? null,
    expectedBaseSha: options.expectedBaseSha ?? eligibility.data.baseSha ?? null,
    exactHeadBound:
      typeof eligibility.data.headSha === "string" &&
      (options.expectedHeadSha === undefined || options.expectedHeadSha === eligibility.data.headSha),
    exactBaseBound:
      typeof eligibility.data.baseSha === "string" &&
      (options.expectedBaseSha === undefined || options.expectedBaseSha === eligibility.data.baseSha),
    requiredChecks,
    checks: checks ?? null,
    checkSummary: grouped,
    performanceEvidenceChecks,
    draft: eligibility.data.draft ?? null,
    mergeable: eligibility.data.mergeable ?? null,
    mergeStateStatus: eligibility.data.mergeStateStatus ?? null,
    reviewDecision: eligibility.data.reviewDecision ?? null,
    reviewThreads: eligibility.data.reviewThreads ?? null,
    declaredDependencies: eligibility.data.declaredDependencies ?? [],
    dependencies: eligibility.data.dependencies ?? [],
    policySensitiveFiles: eligibility.data.policySensitiveFiles ?? [],
    blockers: [
      ...new Set([
        ...(Array.isArray(eligibility.data.blockers)
          ? eligibility.data.blockers.filter((entry): entry is string => typeof entry === "string")
          : []),
        ...receiptBlockers,
      ]),
    ].sort(),
  });

  const blockers = data.blockers as string[];
  const status: ResultStatus =
    eligibility.status === "error"
      ? "error"
      : eligibility.status === "failed"
        ? "failed"
        : blockers.length > 0 || eligibility.status !== "passed"
          ? "unavailable"
          : "passed";
  for (const blocker of receiptBlockers) {
    diagnostics.push({ code: blocker.split(":", 1)[0], message: blocker });
  }
  return envelope(status, started, data, diagnostics);
}
