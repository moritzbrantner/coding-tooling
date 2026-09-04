import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  repositoryMergeReadiness,
  type RepositoryMergeReadiness,
  type RepositoryMergeReadinessOptions,
} from "./merge-readiness.ts";
import {
  evaluatePullRequestMergeEligibility,
  type PullRequestCheckEvidence,
  type PullRequestMergeEvidence,
} from "./pr-merge-eligibility.ts";
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
  changedFiles?: unknown;
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

function commandBlocker(code: string, fallback: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.error || fallback;
  return `${code}:${detail}`;
}

function changedFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const path = (entry as PullRequestFile).path;
      return typeof path === "string" ? path : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .sort();
}

function changedFileCount(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

export function policySensitivePath(path: string): boolean {
  return (
    path === ".coding-tooling.json" ||
    path === ".coding-tooling.source-deps.json" ||
    path === ".repository.toml" ||
    path === ".github/dependabot.yml" ||
    path === "action.yml" ||
    path === "action.yaml" ||
    path === "renovate.json" ||
    path === "src/entry.ts" ||
    path === "src/merge-readiness.ts" ||
    path === "src/pr-eligibility.ts" ||
    path === "src/pr-merge-eligibility.ts" ||
    path === "src/pr.ts" ||
    path.startsWith(".github/actions/") ||
    path.startsWith(".github/workflows/")
  );
}

export function declaredPullRequestDependencies(body: string): number[] {
  const dependencies = new Set<number>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, "").trim();
    const declaration = line.match(
      /^(?:depends(?:[- ]on)?|stacked(?:[- ]on)?|after)\s*:?\s*(.+)$/i,
    );
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
      "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup,url,body,files,changedFiles",
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
    (entry) => entry && typeof entry === "object" && (entry as ReviewThread).isResolved !== true,
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
  stackBlocked?: boolean;
  blockers: string[];
} {
  const entries: Array<Record<string, unknown>> = [];
  const blockers: string[] = [];
  let unavailable = false;
  let blocked = false;
  for (const dependency of dependencies) {
    const command = runner(
      "gh",
      ["pr", "view", String(dependency), "--json", "number,state,mergedAt,url"],
      root,
    );
    const info = parseJson<DependencyInfo>(command);
    if (!info) {
      unavailable = true;
      blockers.push(
        commandBlocker(
          "dependency-evidence-unavailable",
          `could not read declared dependency #${dependency}`,
          command,
        ),
      );
      entries.push({ number: dependency, resolved: false });
      continue;
    }
    const mergedAt = typeof info.mergedAt === "string" && info.mergedAt ? info.mergedAt : null;
    const resolved = Boolean(mergedAt);
    blocked ||= !resolved;
    entries.push({
      number: dependency,
      state: typeof info.state === "string" ? info.state : null,
      mergedAt,
      url: typeof info.url === "string" ? info.url : null,
      resolved,
    });
  }
  return {
    entries,
    stackBlocked: unavailable ? undefined : blocked,
    blockers,
  };
}

function checkEvidence(value: unknown): PullRequestCheckEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const summary = summarizeChecks(value as Array<Record<string, unknown>>);
  return [
    ...summary.passed.map((name) => ({ name, state: "passed" as const })),
    ...summary.pending.map((name) => ({ name, state: "pending" as const })),
    ...summary.failed.map((name) => ({ name, state: "failed" as const })),
  ];
}

function reviewDecision(value: unknown): PullRequestMergeEvidence["reviewDecision"] | undefined {
  if (value === null) return null;
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  return undefined;
}

function blockerDiagnostics(blockers: string[]): Diagnostic[] {
  return blockers.map((blocker) => ({
    code: blocker.split(":", 1)[0] || "pr-eligibility-blocker",
    message: blocker,
  }));
}

function envelope(
  status: ResultEnvelope<Record<string, unknown>>["status"],
  started: number,
  data: Record<string, unknown>,
  blockers: string[] = [],
): ResultEnvelope<Record<string, unknown>> {
  const normalized = [...new Set(blockers.filter(Boolean))].sort();
  return {
    schemaVersion: 1,
    operation: "pr",
    status,
    durationMs: Date.now() - started,
    data: { ...data, blockers: normalized },
    diagnostics: blockerDiagnostics(normalized),
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
    return envelope("error", started, data, ["invalid-pr-number"]);
  }

  const readiness = readReadiness(root, { run: runner });
  data.repositoryReadiness = readiness;
  if (readiness.readiness !== "trusted-auto-merge") {
    return envelope("unavailable", started, data, [
      `repository-readiness:${readiness.readiness}`,
      ...readiness.blockers.map((blocker) => blocker.code),
    ]);
  }

  const repository = readiness.repository;
  if (!repository) {
    return envelope("unavailable", started, data, ["repository-id-unavailable"]);
  }

  const current = pullRequestInfo(runner, root, prNumber);
  if (!current.info) {
    return envelope("unavailable", started, data, [
      commandBlocker(
        "pr-evidence-unavailable",
        "could not read pull request metadata",
        current.command,
      ),
    ]);
  }

  const pr = current.info;
  const headSha = typeof pr.headRefOid === "string" && pr.headRefOid ? pr.headRefOid : undefined;
  const baseRef = typeof pr.baseRefName === "string" && pr.baseRefName ? pr.baseRefName : undefined;
  const body = typeof pr.body === "string" ? pr.body : "";
  const files = changedFiles(pr.files);
  const fileCount = changedFileCount(pr.changedFiles);
  const fileEvidenceComplete =
    files !== undefined && fileCount !== undefined && files.length === fileCount;
  const declaredDependencies = declaredPullRequestDependencies(body).filter(
    (dependency) => dependency !== prNumber,
  );
  const checks = checkEvidence(pr.statusCheckRollup);
  const base = baseRef ? branchSha(runner, root, repository, baseRef) : undefined;
  const baseSha = base?.sha;
  const threads = reviewThreadEvidence(runner, root, repository, prNumber);
  const dependency = dependencyEvidence(runner, root, declaredDependencies);
  const sensitiveFiles = fileEvidenceComplete ? files.filter(policySensitivePath) : [];

  const collectorBlockers: string[] = [...dependency.blockers];
  if (pr.state !== "OPEN") collectorBlockers.push("pull-request-not-open");
  if (pr.isDraft !== false) collectorBlockers.push("pull-request-draft-or-unknown");
  if (!baseRef) collectorBlockers.push("base-ref-evidence-missing");
  if (base && !baseSha) {
    collectorBlockers.push(
      commandBlocker(
        "base-evidence-unavailable",
        `could not resolve current ${baseRef} head`,
        base.command,
      ),
    );
  }
  const trustedBranch = readiness.evidence.remote?.branch;
  if (!trustedBranch) collectorBlockers.push("trusted-target-branch-evidence-missing");
  else if (baseRef !== trustedBranch) {
    collectorBlockers.push(`target-branch-mismatch:${baseRef ?? "missing"}`);
  }
  if (pr.mergeStateStatus !== "CLEAN") {
    collectorBlockers.push(
      typeof pr.mergeStateStatus === "string"
        ? `merge-state-not-clean:${pr.mergeStateStatus}`
        : "merge-state-evidence-missing",
    );
  }
  if (!fileEvidenceComplete) collectorBlockers.push("changed-file-evidence-incomplete");
  if (threads.unresolved === undefined || threads.complete === undefined) {
    collectorBlockers.push(
      commandBlocker(
        "review-thread-evidence-unavailable",
        "could not establish review-thread state",
        threads.command,
      ),
    );
  } else if (!threads.complete) {
    collectorBlockers.push("review-thread-evidence-incomplete");
  }

  const mergeable =
    pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : undefined;
  const evidence: PullRequestMergeEvidence = {
    expectedHeadSha: options.expectedHeadSha ?? headSha,
    currentHeadSha: headSha,
    expectedBaseSha: options.expectedBaseSha ?? baseSha,
    currentBaseSha: baseSha,
    mergeable,
    checks,
    reviewDecision: reviewDecision(pr.reviewDecision),
    unresolvedBlockingThreads: threads.complete ? threads.unresolved : undefined,
    stackBlocked: dependency.stackBlocked,
    changesIntegrationPolicy: fileEvidenceComplete ? sensitiveFiles.length > 0 : undefined,
  };
  const decision = evaluatePullRequestMergeEligibility(
    {
      readiness: readiness.readiness,
      requiredChecks: readiness.evidence.requiredChecks,
    },
    evidence,
  );
  const blockers = [...collectorBlockers, ...decision.blockers];

  Object.assign(data, {
    url: typeof pr.url === "string" ? pr.url : null,
    headSha: headSha ?? null,
    baseRef: baseRef ?? null,
    baseSha: baseSha ?? null,
    state: typeof pr.state === "string" ? pr.state : null,
    draft: typeof pr.isDraft === "boolean" ? pr.isDraft : null,
    mergeable: typeof pr.mergeable === "string" ? pr.mergeable : null,
    mergeStateStatus: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : null,
    reviewDecision: pr.reviewDecision ?? null,
    changedFiles: files ?? null,
    changedFileCount: fileCount ?? null,
    fileEvidenceComplete,
    policySensitiveFiles: sensitiveFiles,
    declaredDependencies,
    dependencies: dependency.entries,
    reviewThreads: {
      unresolved: threads.unresolved ?? null,
      complete: threads.complete ?? null,
    },
    evidence,
  });

  if (blockers.length > 0 || !decision.eligible) {
    return envelope("unavailable", started, data, blockers);
  }

  data.eligible = true;
  data.receipt = {
    repository,
    prNumber,
    headSha,
    baseRef,
    baseSha,
    requiredChecks: readiness.evidence.requiredChecks,
  };
  return envelope("passed", started, data);
}
