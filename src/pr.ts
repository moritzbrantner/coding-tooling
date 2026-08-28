import { runPlan } from "./core.ts";
import { type Diagnostic, type ResultEnvelope, type ResultStatus } from "./model.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type PipelineRunner = typeof runPlan;

export type MergeMethod = "merge" | "squash" | "rebase";

export type PullRequestIntegrationOptions = {
  tier?: string;
  mergeMethod?: MergeMethod;
  remote?: string;
  dryRun?: boolean;
};

type PullRequestInfo = {
  number: number;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  headRefOid: string;
  baseRefName: string;
  statusCheckRollup?: Array<Record<string, unknown>>;
  url?: string;
};

type CheckSummary = {
  total: number;
  passed: string[];
  pending: string[];
  failed: string[];
};

type Dependencies = {
  run?: Runner;
  runPipeline?: PipelineRunner;
};

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

function parsePullRequestInfo(result: CommandResult): PullRequestInfo | undefined {
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as PullRequestInfo;
  } catch {
    return undefined;
  }
}

function readPullRequest(
  runner: Runner,
  root: string,
  prNumber: number,
): {
  command: CommandResult;
  info?: PullRequestInfo;
} {
  const command = runner(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup,url",
    ],
    root,
  );
  return { command, info: parsePullRequestInfo(command) };
}

function checkName(check: Record<string, unknown>): string {
  const name = check.name ?? check.context ?? check.__typename;
  return typeof name === "string" && name ? name : "unnamed-check";
}

export function summarizeChecks(checks: Array<Record<string, unknown>> = []): CheckSummary {
  const summary: CheckSummary = { total: checks.length, passed: [], pending: [], failed: [] };
  for (const check of checks) {
    const name = checkName(check);
    if (check.__typename === "CheckRun" || "conclusion" in check || "status" in check) {
      const status = typeof check.status === "string" ? check.status.toUpperCase() : "";
      const conclusion = typeof check.conclusion === "string" ? check.conclusion.toUpperCase() : "";
      if (status && status !== "COMPLETED") summary.pending.push(name);
      else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) summary.passed.push(name);
      else if (!conclusion) summary.pending.push(name);
      else summary.failed.push(name);
      continue;
    }

    const state = typeof check.state === "string" ? check.state.toUpperCase() : "";
    if (state === "SUCCESS") summary.passed.push(name);
    else if (state === "PENDING" || state === "EXPECTED" || !state) summary.pending.push(name);
    else summary.failed.push(name);
  }
  return summary;
}

function commandDiagnostic(code: string, fallback: string, result: CommandResult): Diagnostic {
  return {
    code,
    message: result.stderr.trim() || result.error || fallback,
  };
}

function restoreCheckout(
  runner: Runner,
  root: string,
  originalBranch: string | undefined,
  originalHead: string,
  temporaryRef: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  runner("git", ["reset", "--hard", "HEAD"], root);
  const checkout = originalBranch
    ? runner("git", ["checkout", "--quiet", originalBranch], root)
    : runner("git", ["checkout", "--quiet", "--detach", originalHead], root);
  if (checkout.status !== 0)
    diagnostics.push(
      commandDiagnostic("restore-checkout-failed", "Could not restore checkout", checkout),
    );
  const removeRef = runner("git", ["update-ref", "-d", temporaryRef], root);
  if (removeRef.status !== 0)
    diagnostics.push(
      commandDiagnostic(
        "temporary-ref-cleanup-failed",
        "Could not remove temporary PR ref",
        removeRef,
      ),
    );
  return diagnostics;
}

export function integratePullRequest(
  root: string,
  prNumber: number,
  options: PullRequestIntegrationOptions = {},
  dependencies: Dependencies = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const pipelineRunner = dependencies.runPipeline ?? runPlan;
  const tier = options.tier ?? "full";
  const mergeMethod = options.mergeMethod ?? "squash";
  const remote = options.remote ?? "origin";
  const data: Record<string, unknown> = {
    root,
    prNumber,
    tier,
    mergeMethod,
    remote,
    dryRun: Boolean(options.dryRun),
    merged: false,
  };

  if (!Number.isInteger(prNumber) || prNumber <= 0)
    return envelope("error", started, data, [
      { code: "invalid-pr-number", message: "Pull request number must be a positive integer" },
    ]);

  for (const command of ["git", "gh"]) {
    const available = runner(command, ["--version"], root);
    if (available.status !== 0)
      return envelope("unavailable", started, data, [
        commandDiagnostic(`${command}-unavailable`, `${command} is unavailable`, available),
      ]);
  }

  const status = runner("git", ["status", "--porcelain"], root);
  if (status.status !== 0)
    return envelope("error", started, data, [
      commandDiagnostic("git-status-failed", "Could not inspect the working tree", status),
    ]);
  if (status.stdout.trim())
    return envelope("unavailable", started, data, [
      {
        code: "dirty-working-tree",
        message:
          "PR integration requires a clean working tree so the original checkout can be restored safely",
      },
    ]);

  const originalHeadResult = runner("git", ["rev-parse", "HEAD"], root);
  if (originalHeadResult.status !== 0)
    return envelope("error", started, data, [
      commandDiagnostic("git-head-failed", "Could not resolve HEAD", originalHeadResult),
    ]);
  const originalHead = originalHeadResult.stdout.trim();
  const branchResult = runner("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const originalBranch = branchResult.status === 0 ? branchResult.stdout.trim() : undefined;

  const initial = readPullRequest(runner, root, prNumber);
  if (!initial.info)
    return envelope("unavailable", started, data, [
      commandDiagnostic("pr-read-failed", "Could not read pull request metadata", initial.command),
    ]);
  const pr = initial.info;
  Object.assign(data, {
    url: pr.url,
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
  });
  if (pr.state !== "OPEN")
    return envelope("unavailable", started, data, [
      { code: "pr-not-open", message: `Pull request #${prNumber} is ${pr.state.toLowerCase()}` },
    ]);
  if (pr.isDraft)
    return envelope("unavailable", started, data, [
      { code: "pr-is-draft", message: `Pull request #${prNumber} is still a draft` },
    ]);

  const baseRef = `refs/remotes/${remote}/${pr.baseRefName}`;
  const temporaryRef = `refs/coding-tooling/pr/${prNumber}`;
  const fetchBase = runner(
    "git",
    ["fetch", "--quiet", remote, `+refs/heads/${pr.baseRefName}:${baseRef}`],
    root,
  );
  if (fetchBase.status !== 0)
    return envelope("unavailable", started, data, [
      commandDiagnostic(
        "base-fetch-failed",
        `Could not fetch ${remote}/${pr.baseRefName}`,
        fetchBase,
      ),
    ]);
  const fetchHead = runner(
    "git",
    ["fetch", "--quiet", remote, `+refs/pull/${prNumber}/head:${temporaryRef}`],
    root,
  );
  if (fetchHead.status !== 0)
    return envelope("unavailable", started, data, [
      commandDiagnostic("pr-fetch-failed", `Could not fetch pull request #${prNumber}`, fetchHead),
    ]);

  const baseShaResult = runner("git", ["rev-parse", baseRef], root);
  const headShaResult = runner("git", ["rev-parse", temporaryRef], root);
  if (baseShaResult.status !== 0 || headShaResult.status !== 0) {
    runner("git", ["update-ref", "-d", temporaryRef], root);
    return envelope("error", started, data, [
      ...(baseShaResult.status !== 0
        ? [
            commandDiagnostic(
              "base-revision-failed",
              "Could not resolve fetched base",
              baseShaResult,
            ),
          ]
        : []),
      ...(headShaResult.status !== 0
        ? [
            commandDiagnostic(
              "pr-revision-failed",
              "Could not resolve fetched PR head",
              headShaResult,
            ),
          ]
        : []),
    ]);
  }
  const baseSha = baseShaResult.stdout.trim();
  const headSha = headShaResult.stdout.trim();
  Object.assign(data, { baseSha, headSha });
  if (headSha !== pr.headRefOid) {
    runner("git", ["update-ref", "-d", temporaryRef], root);
    return envelope("unavailable", started, data, [
      {
        code: "pr-head-moved-during-fetch",
        message: `PR head changed from ${pr.headRefOid} to ${headSha}; rerun against the current head`,
      },
    ]);
  }

  const checkout = runner("git", ["checkout", "--quiet", "--detach", headSha], root);
  if (checkout.status !== 0) {
    runner("git", ["update-ref", "-d", temporaryRef], root);
    return envelope("error", started, data, [
      commandDiagnostic("pr-checkout-failed", "Could not checkout fetched PR head", checkout),
    ]);
  }

  const syntheticMerge = runner(
    "git",
    [
      "-c",
      "user.name=coding-tooling",
      "-c",
      "user.email=coding-tooling@local.invalid",
      "merge",
      "--no-ff",
      "--no-edit",
      baseSha,
    ],
    root,
  );
  if (syntheticMerge.status !== 0) {
    const restoreDiagnostics = restoreCheckout(
      runner,
      root,
      originalBranch,
      originalHead,
      temporaryRef,
    );
    return envelope("failed", started, data, [
      commandDiagnostic(
        "local-merge-conflict",
        `Pull request #${prNumber} does not merge cleanly with ${pr.baseRefName}`,
        syntheticMerge,
      ),
      ...restoreDiagnostics,
    ]);
  }

  const pipeline = pipelineRunner({ root, tier, strict: false });
  data.pipeline = pipeline;
  if (pipeline.status !== "passed") {
    const restoreDiagnostics = restoreCheckout(
      runner,
      root,
      originalBranch,
      originalHead,
      temporaryRef,
    );
    return envelope(pipeline.status === "failed" ? "failed" : pipeline.status, started, data, [
      {
        code: "local-pipeline-not-green",
        message: `Local ${tier} pipeline returned ${pipeline.status}; pull request was not merged`,
      },
      ...restoreDiagnostics,
    ]);
  }

  const postPipelineStatus = runner("git", ["status", "--porcelain", "--untracked-files=no"], root);
  if (postPipelineStatus.status !== 0 || postPipelineStatus.stdout.trim()) {
    const restoreDiagnostics = restoreCheckout(
      runner,
      root,
      originalBranch,
      originalHead,
      temporaryRef,
    );
    return envelope("failed", started, data, [
      postPipelineStatus.status !== 0
        ? commandDiagnostic(
            "post-pipeline-status-failed",
            "Could not inspect pipeline mutations",
            postPipelineStatus,
          )
        : {
            code: "pipeline-mutated-tracked-files",
            message:
              "The local pipeline changed tracked files; integration stopped instead of merging an untested tree",
          },
      ...restoreDiagnostics,
    ]);
  }

  const current = readPullRequest(runner, root, prNumber);
  if (!current.info) {
    const restoreDiagnostics = restoreCheckout(
      runner,
      root,
      originalBranch,
      originalHead,
      temporaryRef,
    );
    return envelope("unavailable", started, data, [
      commandDiagnostic(
        "pr-refresh-failed",
        "Could not refresh pull request metadata",
        current.command,
      ),
      ...restoreDiagnostics,
    ]);
  }
  const refreshed = current.info;
  const checks = summarizeChecks(refreshed.statusCheckRollup);
  Object.assign(data, {
    mergeable: refreshed.mergeable,
    mergeStateStatus: refreshed.mergeStateStatus,
    reviewDecision: refreshed.reviewDecision,
    remoteChecks: checks,
  });

  const refreshBase = runner(
    "git",
    ["fetch", "--quiet", remote, `+refs/heads/${refreshed.baseRefName}:${baseRef}`],
    root,
  );
  const currentBaseShaResult = runner("git", ["rev-parse", baseRef], root);
  const currentBaseSha =
    currentBaseShaResult.status === 0 ? currentBaseShaResult.stdout.trim() : "";

  const blockingDiagnostics: Diagnostic[] = [];
  if (refreshed.headRefOid !== headSha)
    blockingDiagnostics.push({
      code: "pr-head-moved",
      message: `PR head moved to ${refreshed.headRefOid} after local verification; rerun the pipeline`,
    });
  if (refreshBase.status !== 0 || currentBaseShaResult.status !== 0)
    blockingDiagnostics.push(
      refreshBase.status !== 0
        ? commandDiagnostic(
            "base-refresh-failed",
            "Could not refresh the target branch",
            refreshBase,
          )
        : commandDiagnostic(
            "base-revision-failed",
            "Could not resolve refreshed target branch",
            currentBaseShaResult,
          ),
    );
  else if (currentBaseSha !== baseSha)
    blockingDiagnostics.push({
      code: "base-moved",
      message: `${refreshed.baseRefName} moved from ${baseSha} to ${currentBaseSha} after local verification; rerun the pipeline`,
    });
  if (checks.pending.length > 0)
    blockingDiagnostics.push({
      code: "remote-checks-pending",
      message: `Remote checks are still pending: ${checks.pending.join(", ")}`,
    });
  if (checks.failed.length > 0)
    blockingDiagnostics.push({
      code: "remote-checks-failed",
      message: `Remote checks are not green: ${checks.failed.join(", ")}`,
    });
  if (refreshed.mergeable !== "MERGEABLE")
    blockingDiagnostics.push({
      code: "pr-not-mergeable",
      message: `GitHub reports pull request #${prNumber} as ${refreshed.mergeable.toLowerCase()}`,
    });
  if (
    refreshed.reviewDecision === "CHANGES_REQUESTED" ||
    refreshed.reviewDecision === "REVIEW_REQUIRED"
  )
    blockingDiagnostics.push({
      code: "review-blocks-merge",
      message: `Review state ${refreshed.reviewDecision.toLowerCase()} blocks integration`,
    });

  const restoreDiagnostics = restoreCheckout(
    runner,
    root,
    originalBranch,
    originalHead,
    temporaryRef,
  );
  if (restoreDiagnostics.length > 0)
    return envelope("error", started, data, [...blockingDiagnostics, ...restoreDiagnostics]);
  if (blockingDiagnostics.length > 0)
    return envelope("unavailable", started, data, blockingDiagnostics);

  if (options.dryRun) return envelope("passed", started, data);

  const merge = runner(
    "gh",
    ["pr", "merge", String(prNumber), `--${mergeMethod}`, "--match-head-commit", headSha],
    root,
  );
  if (merge.status !== 0)
    return envelope("failed", started, data, [
      commandDiagnostic(
        "pr-merge-failed",
        `GitHub refused to merge pull request #${prNumber}`,
        merge,
      ),
    ]);

  data.merged = true;
  return envelope("passed", started, data);
}
