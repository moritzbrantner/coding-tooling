import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import {
  evaluatePullRequestMergeEligibility,
  type PullRequestCheckEvidence,
  type PullRequestMergeEvidence,
} from "./pr-merge-eligibility.ts";
import { summarizeChecks } from "./pr.ts";
import {
  repositoryMergeReadiness,
  type RepositoryMergeReadiness,
} from "./merge-readiness.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type PullRequestView = {
  number?: unknown;
  state?: unknown;
  isDraft?: unknown;
  mergeable?: unknown;
  headRefOid?: unknown;
  baseRefOid?: unknown;
  baseRefName?: unknown;
  reviewDecision?: unknown;
  statusCheckRollup?: unknown;
  files?: unknown;
  changedFiles?: unknown;
  url?: unknown;
};

type ReviewThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{ isResolved?: unknown }>;
          pageInfo?: {
            hasNextPage?: unknown;
            endCursor?: unknown;
          };
        };
      };
    };
  };
};

export type PullRequestEligibilityOptions = {
  expectedHeadSha?: string;
  expectedBaseSha?: string;
  run?: Runner;
};

type ReviewThreadEvidence = {
  count?: number;
  diagnostics: Diagnostic[];
};

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

function reviewDecision(value: unknown): PullRequestMergeEvidence["reviewDecision"] {
  if (value === null || value === "") return null;
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  return undefined;
}

function mergeable(value: unknown): boolean | undefined {
  if (value === "MERGEABLE") return true;
  if (value === "CONFLICTING") return false;
  return undefined;
}

function checks(value: unknown): PullRequestCheckEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const summary = summarizeChecks(value as Array<Record<string, unknown>>);
  return [
    ...summary.passed.map((name) => ({ name, state: "passed" as const })),
    ...summary.pending.map((name) => ({ name, state: "pending" as const })),
    ...summary.failed.map((name) => ({ name, state: "failed" as const })),
  ];
}

export function changesIntegrationPolicy(repository: string | null, paths: string[]): boolean {
  const genericPolicyPaths = paths.some(
    (path) =>
      path === ".repository.toml" ||
      path === ".coding-tooling.json" ||
      path === ".coding-tooling.source-deps.json" ||
      path === "action.yml" ||
      path === "action.yaml" ||
      path.startsWith(".github/workflows/"),
  );
  if (genericPolicyPaths) return true;
  if (repository !== "moritzbrantner/coding-tooling") return false;
  const toolingPolicyPaths = new Set([
    "src/cli.ts",
    "src/entry.ts",
    "src/merge-readiness.ts",
    "src/pr-eligibility.ts",
    "src/pr-merge-eligibility.ts",
    "src/pr.ts",
  ]);
  return paths.some((path) => toolingPolicyPaths.has(path));
}

function changedPaths(view: PullRequestView): { paths?: string[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!Array.isArray(view.files) || typeof view.changedFiles !== "number") {
    return {
      diagnostics: [
        {
          code: "pr-changed-files-evidence-missing",
          message: "Pull request changed-file evidence is missing",
        },
      ],
    };
  }
  const paths = view.files
    .map((file) => {
      if (!file || typeof file !== "object") return undefined;
      const path = (file as { path?: unknown }).path;
      return typeof path === "string" && path ? path : undefined;
    })
    .filter((path): path is string => Boolean(path));
  if (paths.length !== view.files.length || paths.length !== view.changedFiles) {
    diagnostics.push({
      code: "pr-changed-files-evidence-incomplete",
      message:
        "Pull request changed-file evidence is incomplete; integration-policy changes cannot be ruled out",
    });
    return { diagnostics };
  }
  return { paths, diagnostics };
}

function reviewThreads(
  runner: Runner,
  root: string,
  repository: string,
  prNumber: number,
): ReviewThreadEvidence {
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    return {
      diagnostics: [
        {
          code: "pr-review-thread-repository-invalid",
          message: `Repository ${repository} is not in owner/name form`,
        },
      ],
    };
  }

  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`;
  let after: string | undefined;
  let unresolved = 0;

  for (let page = 0; page < 20; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const command = runner("gh", args, root);
    const response = parseJson<ReviewThreadsResponse>(command);
    const threads = response?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads || !Array.isArray(threads.nodes) || !threads.pageInfo) {
      return {
        diagnostics: [
          commandDiagnostic(
            "pr-review-thread-evidence-unavailable",
            "Could not read pull request review threads",
            command,
          ),
        ],
      };
    }

    for (const thread of threads.nodes) {
      if (thread.isResolved !== true) unresolved += 1;
    }

    if (threads.pageInfo.hasNextPage === false) return { count: unresolved, diagnostics: [] };
    const cursor = threads.pageInfo.endCursor;
    if (threads.pageInfo.hasNextPage !== true || typeof cursor !== "string" || !cursor) {
      return {
        diagnostics: [
          {
            code: "pr-review-thread-pagination-invalid",
            message: "Review-thread pagination evidence is incomplete",
          },
        ],
      };
    }
    after = cursor;
  }

  return {
    diagnostics: [
      {
        code: "pr-review-thread-pagination-limit",
        message: "Review-thread evidence exceeded the bounded 2000-thread collection limit",
      },
    ],
  };
}

function readPullRequest(
  runner: Runner,
  root: string,
  repository: string,
  prNumber: number,
): { view?: PullRequestView; command: CommandResult } {
  const command = runner(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repository,
      "--json",
      "number,state,isDraft,mergeable,headRefOid,baseRefOid,baseRefName,reviewDecision,statusCheckRollup,files,changedFiles,url",
    ],
    root,
  );
  return { command, view: parseJson<PullRequestView>(command) };
}

function evidenceFromView(
  repository: RepositoryMergeReadiness,
  view: PullRequestView,
  options: PullRequestEligibilityOptions,
  unresolvedBlockingThreads: number | undefined,
  policyPaths: string[] | undefined,
): PullRequestMergeEvidence {
  const defaultBranch = repository.evidence.remote?.branch;
  const baseRefName = typeof view.baseRefName === "string" ? view.baseRefName : undefined;
  return {
    open: typeof view.state === "string" ? view.state === "OPEN" : undefined,
    draft: typeof view.isDraft === "boolean" ? view.isDraft : undefined,
    expectedHeadSha: options.expectedHeadSha,
    currentHeadSha: typeof view.headRefOid === "string" ? view.headRefOid : undefined,
    expectedBaseSha: options.expectedBaseSha,
    currentBaseSha: typeof view.baseRefOid === "string" ? view.baseRefOid : undefined,
    mergeable: mergeable(view.mergeable),
    checks: checks(view.statusCheckRollup),
    reviewDecision: reviewDecision(view.reviewDecision),
    unresolvedBlockingThreads,
    stackBlocked:
      typeof defaultBranch === "string" && baseRefName ? baseRefName !== defaultBranch : undefined,
    changesIntegrationPolicy: policyPaths
      ? changesIntegrationPolicy(repository.repository, policyPaths)
      : undefined,
  };
}

export function pullRequestMergeEligibility(
  root: string,
  prNumber: number,
  options: PullRequestEligibilityOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = options.run ?? runCommand;
  const repository = repositoryMergeReadiness(root, { run: runner });
  const diagnostics: Diagnostic[] = [];

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return {
      schemaVersion: 1,
      operation: "pr-eligibility",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, prNumber, repository },
      diagnostics: [
        { code: "invalid-pr-number", message: "Pull request number must be a positive integer" },
      ],
    };
  }

  if (!repository.repository) {
    return {
      schemaVersion: 1,
      operation: "pr-eligibility",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: { root, prNumber, repository },
      diagnostics: [
        {
          code: "pr-repository-id-unavailable",
          message: "Repository metadata does not provide an owner/name repository ID",
        },
      ],
    };
  }

  const current = readPullRequest(runner, root, repository.repository, prNumber);
  if (!current.view) {
    return {
      schemaVersion: 1,
      operation: "pr-eligibility",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: { root, prNumber, repository },
      diagnostics: [
        commandDiagnostic("pr-read-failed", "Could not read pull request metadata", current.command),
      ],
    };
  }
  if (current.view.number !== prNumber) {
    return {
      schemaVersion: 1,
      operation: "pr-eligibility",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: { root, prNumber, repository },
      diagnostics: [
        {
          code: "pr-identity-mismatch",
          message: `Requested pull request #${prNumber}, but GitHub evidence identified #${String(current.view.number)}`,
        },
      ],
    };
  }

  const pathEvidence = changedPaths(current.view);
  diagnostics.push(...pathEvidence.diagnostics);
  const threadEvidence = reviewThreads(runner, root, repository.repository, prNumber);
  diagnostics.push(...threadEvidence.diagnostics);

  const evidence = evidenceFromView(
    repository,
    current.view,
    options,
    threadEvidence.count,
    pathEvidence.paths,
  );
  const eligibility = evaluatePullRequestMergeEligibility(
    {
      readiness: repository.readiness,
      requiredChecks: repository.evidence.requiredChecks,
    },
    evidence,
  );

  const status: ResultStatus = diagnostics.length > 0
    ? "unavailable"
    : eligibility.eligible
      ? "passed"
      : "failed";

  return {
    schemaVersion: 1,
    operation: "pr-eligibility",
    status,
    durationMs: Date.now() - started,
    data: {
      root,
      prNumber,
      url: typeof current.view.url === "string" ? current.view.url : null,
      repository,
      evidence,
      eligibility,
    },
    diagnostics,
  };
}
