import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  repositoryMergeReadiness,
  type RepositoryMergeReadiness,
  type RepositoryMergeReadinessOptions,
} from "./merge-readiness.ts";
import { summarizeChecks } from "./pr.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type ReadinessReader = (
  root: string,
  options?: RepositoryMergeReadinessOptions,
) => RepositoryMergeReadiness;

type PullRequestFile = {
  path?: unknown;
};

type PullRequestInfo = {
  number?: unknown;
  state?: unknown;
  isDraft?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  reviewDecision?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  statusCheckRollup?: unknown;
  url?: unknown;
  body?: unknown;
  files?: unknown;
};

type BranchInfo = {
  commit?: {
    sha?: unknown;
  };
};

type ReviewThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: unknown;
          pageInfo?: {
            hasNextPage?: unknown;
          };
        };
      };
    };
  };
};

type ReviewThread = {
  isResolved?: unknown;
};

type DependencyInfo = {
  number?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  url?: unknown;
};

export type PullRequestEligibilityOptions = {
  expectedHeadSha?: string;
  expectedBaseSha?: string;
};

export type PullRequestEligibilityDependencies = {
  run?: Runner;
  readRepositoryReadiness?: ReadinessReader;
};

const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

function parseJson<T>(result: CommandResult): T | undefined {
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

function commandDiagnostic(code: string, fallback: string, result: CommandResult): Diagnostic {
  return {
    code,
    message: result.stderr.trim() || result.error || fallback,
  };
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function changedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const path = (entry as PullRequestFile).path;
      return typeof path === "string" ? path : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .sort();
}

export function policySensitivePath(path: string): boolean {
  return (
    path === ".coding-tooling.json" ||
    path === ".coding-tooling.source-deps.json" ||
    path === ".github/dependabot.yml" ||
    path === "action.yml" ||
    path === "action.yaml" ||
    path === "renovate.json" ||
    path === "src/merge-readiness.ts" ||
    path === "src/pr-eligibility.ts" ||
    path === "src/pr.ts" ||
    path === "docs/merge-readiness.md" ||
    path === "docs/trusted-auto-merge.md" ||
    path.startsWith(".github/actions/") ||
    path.startsWith(".github/workflows/")
  );
}

export function declaredPullRequestDependencies(body: string): number[] {
  const dependencies = new Set<number>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, "").trim();
    const declaration = line.match(/^(?:depends(?:[- ]on)?|stacked(?:[- ]on)?|after)\s*:?\s*(.+)$/i);
    if (!declaration) continue;
    for (const match of declaration[1]!.matchAll(/#(\d+)/g)) {
      const number = Number(match[1]);
      if (Number.isInteger(number) && number > 0) dependencies.add(number);
    }
  }
  return [...dependencies].sort((left, right) => left - right);
}

function pullRequestInfo(
  runner: Runner,
  root: string,
  prNumber: number,
): { command: CommandResult; info?: PullRequestInfo } {
  const command = runner(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup,url,body,files",
    ],
    root,
  );
  return { command, info: parseJson<PullRequestInfo>(command) };
}

function branchSha(
  runner: Runner,
  root: string,
  repository: string,
  branch: string,
): { command: CommandResult; sha?: string } {
  const command = runner(
    "gh",
    ["api", `repos/${repository}/branches/${encodeURIComponent(branch)}`],
    root,
  );
  const info = parseJson<BranchInfo>(command);
  const sha = info?.commit?.sha;
  return { command, sha: typeof sha === "string" && sha ? sha : undefined };
}

function reviewThreadEvidence(
  runner: Runner,
  root: string,
  repository: string,
  prNumber: number,
): {
  command: CommandResult;
  unresolved?: number;
  complete?: boolean;
} {
  const [owner, name] = repository.split("/", 2);
  if (!owner || !name) {
    return {
      command: {
        command: [],
        status: 1,
        stdout: "",
        stderr: `Invalid repository id: ${repository}`,
      },
    };
  }
  const command = runner(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
      "-f",
      `query=${reviewThreadsQuery}`,
    ],
    root,
  );
  const response = parseJson<ReviewThreadsResponse>(command);
  const threads = response?.data?.repository?.pullRequest?.reviewThreads;
  if (!threads || !Array.isArray(threads.nodes)) return { command };
  const unresolved = threads.nodes.filter(
    (entry) =>
      entry && typeof entry === "object" && (entry as ReviewThread).isResolved !== true,
  ).length;
  return {
    command,
    unresolved,
    complete: threads.pageInfo?.hasNextPage === false,
  };
}

function dependencyEvidence(
  runner: Runner,
  root: string,
  dependencies: number[],
): {
  entries: Array<Record<string, unknown>>;
  blockers: Diagnostic[];
} {
  const entries: Array<Record<string, unknown>> = [];
  const blockers: Diagnostic[] = [];
  for (const dependency of dependencies) {
    const command = runner(
      "gh",
      ["pr", "view", String(dependency), "--json", "number,state,mergedAt,url"],
      root,
    );
    const info = parseJson<DependencyInfo>(command);
    if (!info) {
      blockers.push(
        commandDiagnostic(
          "pr-dependency-evidence-unavailable",
          `Could not read declared dependency #${dependency}`,
          command,
        ),
      );
      entries.push({ number: dependency, resolved: false });
      continue;
    }
    const mergedAt = typeof info.mergedAt === "string" && info.mergedAt ? info.mergedAt : null;
    const resolved = Boolean(mergedAt);
    entries.push({
      number: dependency,
      state: typeof info.state === "string" ? info.state : null,
      mergedAt,
      url: typeof info.url === "string" ? info.url : null,
      resolved,
    });
    if (!resolved) {
      blockers.push({
        code: "pr-dependency-unresolved",
        message: `Declared pull-request dependency #${dependency} has not been merged`,
      });
    }
  }
  return { entries, blockers };
}

function envelope(
  status: ResultEnvelope<Record<string, unknown>>["status"],
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

export function pullRequestMergeEligibility(
  root: string,
  prNumber: number,
  options: PullRequestEligibilityOptions = {},
  dependencies: PullRequestEligibilityDependencies = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const readReadiness = dependencies.readRepositoryReadiness ?? repositoryMergeReadiness;
  const data: Record<string, unknown> = {
    root,
    prNumber,
    eligible: false,
    expectedHeadSha: options.expectedHeadSha ?? null,
    expectedBaseSha: options.expectedBaseSha ?? null,
  };

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return envelope("error", started, data, [
      { code: "invalid-pr-number", message: "Pull request number must be a positive integer" },
    ]);
  }

  const readiness = readReadiness(root, { run: runner });
  data.repositoryReadiness = readiness;
  if (readiness.readiness !== "trusted-auto-merge") {
    return envelope("unavailable", started, data, [
      {
        code: "repository-not-trusted-auto-merge",
        message:
          readiness.readiness === "local-gated"
            ? "Repository remains local-gated; use coding-tooling pr integrate or an equivalent stronger runner"
            : `Repository readiness is ${readiness.readiness}; unattended merge is not allowed`,
      },
      ...readiness.blockers,
    ]);
  }

  const repository = readiness.repository;
  if (!repository) {
    return envelope("unavailable", started, data, [
      {
        code: "repository-id-unavailable",
        message: "Repository metadata does not provide the GitHub owner/name needed for PR evidence",
      },
    ]);
  }

  const current = pullRequestInfo(runner, root, prNumber);
  if (!current.info) {
    return envelope("unavailable", started, data, [
      commandDiagnostic("pr-read-failed", "Could not read pull request metadata", current.command),
    ]);
  }
  const pr = current.info;
  const headSha = typeof pr.headRefOid === "string" ? pr.headRefOid : "";
  const baseRef = typeof pr.baseRefName === "string" ? pr.baseRefName : "";
  const body = typeof pr.body === "string" ? pr.body : "";
  const files = changedFiles(pr.files);
  const checks = summarizeChecks(
    Array.isArray(pr.statusCheckRollup)
      ? (pr.statusCheckRollup as Array<Record<string, unknown>>)
      : [],
  );
  const declaredDependencies = declaredPullRequestDependencies(body).filter(
    (dependency) => dependency !== prNumber,
  );
  Object.assign(data, {
    url: typeof pr.url === "string" ? pr.url : null,
    headSha,
    baseRef,
    state: typeof pr.state === "string" ? pr.state : null,
    draft: pr.isDraft === true,
    mergeable: typeof pr.mergeable === "string" ? pr.mergeable : null,
    mergeStateStatus: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : null,
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : null,
    checks,
    changedFiles: files,
    declaredDependencies,
  });

  const blockers: Diagnostic[] = [];
  if (pr.state !== "OPEN") {
    blockers.push({
      code: "pr-not-open",
      message: `Pull request #${prNumber} is not open`,
    });
  }
  if (pr.isDraft === true) {
    blockers.push({
      code: "pr-is-draft",
      message: `Pull request #${prNumber} is still a draft`,
    });
  }
  if (!headSha) {
    blockers.push({
      code: "pr-head-unavailable",
      message: "Pull request head SHA is missing",
    });
  }
  if (!baseRef) {
    blockers.push({
      code: "pr-base-unavailable",
      message: "Pull request base branch is missing",
    });
  }

  const trustedBranch = readiness.evidence.remote?.branch;
  if (baseRef && trustedBranch && baseRef !== trustedBranch) {
    blockers.push({
      code: "pr-target-not-trusted-branch",
      message: `Pull request targets ${baseRef}, but trusted protection evidence is for ${trustedBranch}`,
    });
  }

  const base = baseRef ? branchSha(runner, root, repository, baseRef) : undefined;
  const baseSha = base?.sha ?? "";
  data.baseSha = baseSha;
  if (base && !base.sha) {
    blockers.push(
      commandDiagnostic(
        "pr-base-evidence-unavailable",
        `Could not resolve current ${baseRef} head`,
        base.command,
      ),
    );
  }

  if (options.expectedHeadSha && headSha !== options.expectedHeadSha) {
    blockers.push({
      code: "pr-head-moved",
      message: `PR head moved from ${options.expectedHeadSha} to ${headSha}; re-evaluate the exact head`,
    });
  }
  if (options.expectedBaseSha && baseSha !== options.expectedBaseSha) {
    blockers.push({
      code: "pr-base-moved",
      message: `PR base moved from ${options.expectedBaseSha} to ${baseSha}; re-evaluate against the current base`,
    });
  }

  if (checks.total === 0) {
    blockers.push({
      code: "pr-checks-zero",
      message: "Pull request has zero attached checks; zero checks is never green",
    });
  }
  if (checks.pending.length > 0) {
    blockers.push({
      code: "pr-checks-pending",
      message: `Pull request checks are still pending: ${checks.pending.join(", ")}`,
    });
  }
  if (checks.failed.length > 0) {
    blockers.push({
      code: "pr-checks-failed",
      message: `Pull request checks are not green: ${checks.failed.join(", ")}`,
    });
  }

  const requiredChecks = readiness.evidence.requiredChecks;
  const attachedChecks = [...checks.passed, ...checks.pending, ...checks.failed];
  const missingRequiredChecks = requiredChecks.filter((check) => !attachedChecks.includes(check));
  if (missingRequiredChecks.length > 0) {
    blockers.push({
      code: "pr-required-checks-missing",
      message: `Required current-head checks are missing: ${missingRequiredChecks.join(", ")}`,
    });
  }

  if (pr.mergeable !== "MERGEABLE") {
    blockers.push({
      code: "pr-not-mergeable",
      message: `GitHub does not report pull request #${prNumber} as mergeable`,
    });
  }
  if (pr.mergeStateStatus !== "CLEAN") {
    blockers.push({
      code: "pr-merge-state-not-clean",
      message: `GitHub merge state is ${typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : "unknown"}`,
    });
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") {
    blockers.push({
      code: "pr-review-blocker",
      message: `Review decision ${pr.reviewDecision} blocks unattended merge`,
    });
  }

  const threadEvidence = reviewThreadEvidence(runner, root, repository, prNumber);
  if (threadEvidence.unresolved === undefined || threadEvidence.complete === undefined) {
    blockers.push(
      commandDiagnostic(
        "pr-review-thread-evidence-unavailable",
        "Could not establish unresolved review-thread state",
        threadEvidence.command,
      ),
    );
  } else {
    data.reviewThreads = {
      unresolved: threadEvidence.unresolved,
      complete: threadEvidence.complete,
    };
    if (!threadEvidence.complete) {
      blockers.push({
        code: "pr-review-thread-evidence-incomplete",
        message: "Review thread evidence exceeds one page; unattended merge fails closed",
      });
    }
    if (threadEvidence.unresolved > 0) {
      blockers.push({
        code: "pr-review-threads-unresolved",
        message: `${threadEvidence.unresolved} review thread(s) remain unresolved`,
      });
    }
  }

  const sensitiveFiles = files.filter(policySensitivePath);
  data.policySensitiveFiles = sensitiveFiles;
  if (sensitiveFiles.length > 0) {
    blockers.push({
      code: "pr-changes-merge-policy",
      message: `Pull request changes merge/validation policy surfaces: ${sensitiveFiles.join(", ")}`,
    });
  }

  const dependency = dependencyEvidence(runner, root, declaredDependencies);
  data.dependencies = dependency.entries;
  blockers.push(...dependency.blockers);

  if (blockers.length > 0) return envelope("unavailable", started, data, blockers);

  data.eligible = true;
  data.receipt = {
    repository,
    prNumber,
    headSha,
    baseRef,
    baseSha,
    requiredChecks,
  };
  return envelope("passed", started, data);
}
