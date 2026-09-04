import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import {
  pullRequestMergeEligibility,
  type PullRequestEligibilityDependencies,
  type PullRequestEligibilityOptions,
} from "./pr-eligibility.ts";
import type { MergeMethod } from "./pr.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;
type EligibilityCollector = (
  root: string,
  prNumber: number,
  options?: PullRequestEligibilityOptions,
  dependencies?: PullRequestEligibilityDependencies,
) => ResultEnvelope<Record<string, unknown>>;

export type PullRequestAutoMergeOptions = {
  expectedHeadSha?: string;
  expectedBaseSha?: string;
  mergeMethod?: MergeMethod;
  dryRun?: boolean;
};

export type PullRequestAutoMergeDependencies = {
  run?: Runner;
  collectEligibility?: EligibilityCollector;
};

type EligibilityReceipt = {
  repository: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
  requiredChecks: string[];
};

const commitShaPattern = /^[0-9a-f]{40}$/i;

function commandDiagnostic(code: string, fallback: string, result: CommandResult): Diagnostic {
  return {
    code,
    message: result.stderr.trim() || result.error || fallback,
  };
}

function envelope(
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "pr",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

function eligibilityReceipt(value: unknown): EligibilityReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.repository !== "string" ||
    !receipt.repository ||
    !Number.isInteger(receipt.prNumber) ||
    typeof receipt.headSha !== "string" ||
    !commitShaPattern.test(receipt.headSha) ||
    typeof receipt.baseRef !== "string" ||
    !receipt.baseRef ||
    typeof receipt.baseSha !== "string" ||
    !commitShaPattern.test(receipt.baseSha) ||
    !Array.isArray(receipt.requiredChecks) ||
    !receipt.requiredChecks.every((entry) => typeof entry === "string" && entry.length > 0)
  )
    return undefined;
  return {
    repository: receipt.repository,
    prNumber: receipt.prNumber as number,
    headSha: receipt.headSha,
    baseRef: receipt.baseRef,
    baseSha: receipt.baseSha,
    requiredChecks: receipt.requiredChecks as string[],
  };
}

export function activatePullRequestAutoMerge(
  root: string,
  prNumber: number,
  options: PullRequestAutoMergeOptions = {},
  dependencies: PullRequestAutoMergeDependencies = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const collectEligibility = dependencies.collectEligibility ?? pullRequestMergeEligibility;
  const mergeMethod = options.mergeMethod ?? "squash";
  const expectedHeadSha = options.expectedHeadSha;
  const expectedBaseSha = options.expectedBaseSha;
  const data: Record<string, unknown> = {
    root,
    prNumber,
    mergeMethod,
    dryRun: Boolean(options.dryRun),
    expectedHeadSha: expectedHeadSha ?? null,
    expectedBaseSha: expectedBaseSha ?? null,
    eligible: false,
    activationRequested: false,
  };

  if (!Number.isInteger(prNumber) || prNumber <= 0)
    return envelope("error", started, data, [
      { code: "invalid-pr-number", message: "Pull request number must be a positive integer" },
    ]);

  if (!expectedHeadSha || !commitShaPattern.test(expectedHeadSha))
    return envelope("error", started, data, [
      {
        code: "expected-head-required",
        message:
          "Guarded auto-merge requires the exact 40-character head SHA from an eligibility receipt",
      },
    ]);

  if (!expectedBaseSha || !commitShaPattern.test(expectedBaseSha))
    return envelope("error", started, data, [
      {
        code: "expected-base-required",
        message:
          "Guarded auto-merge requires the exact 40-character base SHA from an eligibility receipt",
      },
    ]);

  const eligibility = collectEligibility(
    root,
    prNumber,
    { expectedHeadSha, expectedBaseSha },
    { run: runner },
  );
  data.eligibility = eligibility;
  data.eligible = eligibility.status === "passed" && eligibility.data.eligible === true;
  if (eligibility.status !== "passed" || eligibility.data.eligible !== true) {
    return envelope(eligibility.status, started, data, eligibility.diagnostics);
  }

  const receipt = eligibilityReceipt(eligibility.data.receipt);
  if (!receipt || receipt.prNumber !== prNumber) {
    return envelope("error", started, data, [
      {
        code: "eligibility-receipt-invalid",
        message:
          "Fresh eligibility passed without a complete receipt for this pull request; no mutation was attempted",
      },
    ]);
  }
  if (receipt.headSha !== expectedHeadSha || receipt.baseSha !== expectedBaseSha) {
    return envelope("unavailable", started, data, [
      {
        code: "eligibility-receipt-mismatch",
        message:
          "Fresh eligibility receipt does not match the caller's exact head/base receipt; no mutation was attempted",
      },
    ]);
  }
  data.receipt = receipt;

  if (options.dryRun) return envelope("passed", started, data);

  const mutation = runner(
    "gh",
    [
      "pr",
      "merge",
      String(prNumber),
      "--auto",
      `--${mergeMethod}`,
      "--match-head-commit",
      receipt.headSha,
    ],
    root,
  );
  if (mutation.status !== 0)
    return envelope("failed", started, data, [
      commandDiagnostic(
        "auto-merge-activation-failed",
        `GitHub refused guarded auto-merge activation for pull request #${prNumber}`,
        mutation,
      ),
    ]);

  data.activationRequested = true;
  data.githubOutput = mutation.stdout.trim() || null;
  return envelope("passed", started, data);
}
