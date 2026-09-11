import { resolve } from "node:path";

import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type RepositoryInfo = {
  defaultBranchRef?: {
    name?: unknown;
  };
};

type PullRequestInfo = {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  isDraft?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  mergedAt?: unknown;
  updatedAt?: unknown;
};

type MergedParentLookup =
  | { available: true; pullRequest?: PullRequestInfo }
  | { available: false; diagnostic: Diagnostic };

export type PullRequestReconciliationState =
  | "clean"
  | "refresh-recommended"
  | "needs-reconciliation";

export type OpenPullRequestReconciliationEntry = {
  number: number;
  title: string;
  url: string | null;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  updatedAt: string | null;
  state: PullRequestReconciliationState;
  reasons: string[];
};

export type OpenPullRequestReconciliationOptions = {
  run?: Runner;
};

function parseJson<T>(result: CommandResult): T | undefined {
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function unavailable(
  started: number,
  root: string,
  diagnostics: Diagnostic[],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "pr-reconciliation",
    status: "unavailable",
    durationMs: Date.now() - started,
    data: { root, pullRequests: [] },
    diagnostics,
  };
}

function mergedParentForBase(
  repository: string,
  baseBranch: string,
  root: string,
  runner: Runner,
): MergedParentLookup {
  const result = runner(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "merged",
      "--head",
      baseBranch,
      "--limit",
      "1",
      "--json",
      "number,headRefName,mergedAt",
    ],
    root,
  );
  const pullRequests = parseJson<PullRequestInfo[]>(result);
  if (!Array.isArray(pullRequests)) {
    return {
      available: false,
      diagnostic: {
        code: "pr-reconciliation-stack-history-unavailable",
        message:
          result.stderr.trim() ||
          result.error ||
          `Could not inspect merged pull-request history for base branch ${baseBranch}`,
      },
    };
  }
  return {
    available: true,
    pullRequest: pullRequests.find(
      (entry) =>
        stringValue(entry.headRefName) === baseBranch && Boolean(stringValue(entry.mergedAt)),
    ),
  };
}

export function openPullRequestReconciliation(
  repositoryRoot: string,
  options: OpenPullRequestReconciliationOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(repositoryRoot);
  const runner = options.run ?? runCommand;
  const metadata = readRepositoryMetadata(root);
  const repository = metadata.metadata?.id;
  if (!repository) {
    return unavailable(started, root, metadata.diagnostics);
  }

  const repositoryCommand = runner(
    "gh",
    ["repo", "view", repository, "--json", "defaultBranchRef"],
    root,
  );
  const repositoryInfo = parseJson<RepositoryInfo>(repositoryCommand);
  const defaultBranch = stringValue(repositoryInfo?.defaultBranchRef?.name);
  if (!defaultBranch) {
    return unavailable(started, root, [
      {
        code: "pr-reconciliation-default-branch-unavailable",
        message:
          repositoryCommand.stderr.trim() ||
          repositoryCommand.error ||
          `Could not read the default branch for ${repository}`,
      },
    ]);
  }

  const listCommand = runner(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,updatedAt",
    ],
    root,
  );
  const rawPullRequests = parseJson<unknown[]>(listCommand);
  if (!Array.isArray(rawPullRequests)) {
    return unavailable(started, root, [
      {
        code: "pr-reconciliation-open-prs-unavailable",
        message:
          listCommand.stderr.trim() ||
          listCommand.error ||
          `Could not list open pull requests for ${repository}`,
      },
    ]);
  }

  const parsed = rawPullRequests
    .filter((entry): entry is PullRequestInfo => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      number: numberValue(entry.number),
      title: stringValue(entry.title),
      url: stringValue(entry.url) || null,
      baseBranch: stringValue(entry.baseRefName),
      headBranch: stringValue(entry.headRefName),
      draft: entry.isDraft === true,
      mergeable: stringValue(entry.mergeable).toUpperCase(),
      mergeStateStatus: stringValue(entry.mergeStateStatus).toUpperCase(),
      updatedAt: stringValue(entry.updatedAt) || null,
    }))
    .filter(
      (entry): entry is typeof entry & { number: number } =>
        entry.number !== undefined && Boolean(entry.baseBranch) && Boolean(entry.headBranch),
    )
    .sort((left, right) => left.number - right.number);

  const openHeadBranches = new Set(parsed.map((entry) => entry.headBranch));
  const mergedParentByBase = new Map<string, MergedParentLookup>();
  const diagnostics: Diagnostic[] = [];
  const pullRequests: OpenPullRequestReconciliationEntry[] = parsed.map((entry) => {
    const blockingReasons: string[] = [];
    const advisoryReasons: string[] = [];

    if (entry.baseBranch !== defaultBranch && !openHeadBranches.has(entry.baseBranch)) {
      if (!mergedParentByBase.has(entry.baseBranch)) {
        mergedParentByBase.set(
          entry.baseBranch,
          mergedParentForBase(repository, entry.baseBranch, root, runner),
        );
      }
      const mergedParent = mergedParentByBase.get(entry.baseBranch)!;
      if (!mergedParent.available) {
        blockingReasons.push(`stack history for ${entry.baseBranch} is unavailable`);
        diagnostics.push(mergedParent.diagnostic);
      } else if (mergedParent.pullRequest) {
        blockingReasons.push(`stacked base ${entry.baseBranch} already merged`);
        diagnostics.push({
          code: "pr-reconciliation-merged-stack-base",
          message: `PR #${entry.number} still targets ${entry.baseBranch}, the head branch of already-merged PR #${numberValue(mergedParent.pullRequest.number) ?? "?"}; retarget it to the surviving base before integration`,
        });
      } else {
        advisoryReasons.push(`non-default base ${entry.baseBranch} has no open parent PR`);
      }
    }

    if (entry.mergeable === "CONFLICTING" || entry.mergeStateStatus === "DIRTY") {
      blockingReasons.push("branch conflicts with its current base");
      diagnostics.push({
        code: "pr-reconciliation-conflicting-branch",
        message: `PR #${entry.number} conflicts with its current base ${entry.baseBranch}`,
      });
    } else if (entry.mergeStateStatus === "BEHIND") {
      advisoryReasons.push(`head is behind ${entry.baseBranch}`);
    }

    const reasons = [...blockingReasons, ...advisoryReasons];
    const state: PullRequestReconciliationState =
      blockingReasons.length > 0
        ? "needs-reconciliation"
        : advisoryReasons.length > 0
          ? "refresh-recommended"
          : "clean";

    return { ...entry, number: entry.number, state, reasons };
  });

  const status: ResultStatus = pullRequests.some((entry) => entry.state === "needs-reconciliation")
    ? "failed"
    : "passed";

  return {
    schemaVersion: 1,
    operation: "pr-reconciliation",
    status,
    durationMs: Date.now() - started,
    data: {
      root,
      repository,
      defaultBranch,
      pullRequests,
      summary: {
        open: pullRequests.length,
        clean: pullRequests.filter((entry) => entry.state === "clean").length,
        refreshRecommended: pullRequests.filter((entry) => entry.state === "refresh-recommended")
          .length,
        needsReconciliation: pullRequests.filter((entry) => entry.state === "needs-reconciliation")
          .length,
      },
    },
    diagnostics,
  };
}
