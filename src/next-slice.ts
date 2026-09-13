import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import { openPullRequestReconciliation } from "./open-pr-reconciliation.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { remediationPlanCommand } from "./remediation-plan.ts";
import { relativePosix, type CommandResult, runCommand, walkFiles } from "./shared.ts";

export type NextSliceKind =
  | "pr-reconcile"
  | "pr-refresh"
  | "pr-review"
  | "roadmap"
  | "issue"
  | "todo"
  | "capability-gap";

export type NextSliceCandidate = {
  kind: NextSliceKind;
  priority: number;
  key: string;
  summary: string;
  source: Record<string, unknown>;
};

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type IssueInfo = {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  labels?: unknown;
};

function parseJson<T>(result: CommandResult): T | undefined {
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

export function rankNextSliceCandidates(candidates: NextSliceCandidate[]): NextSliceCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.key.localeCompare(right.key) ||
      left.summary.localeCompare(right.summary),
  );
}

function pullRequestCandidates(root: string): {
  candidates: NextSliceCandidate[];
  source: ResultEnvelope<Record<string, unknown>>;
} {
  const source = openPullRequestReconciliation(root);
  const entries = Array.isArray(source.data.pullRequests)
    ? (source.data.pullRequests as Array<Record<string, unknown>>)
    : [];
  const candidates = entries.flatMap((entry): NextSliceCandidate[] => {
    const number = Number(entry.number);
    if (!Number.isInteger(number) || number <= 0) return [];
    const title = typeof entry.title === "string" ? entry.title : `PR #${number}`;
    const state = typeof entry.state === "string" ? entry.state : "";
    const reasons = Array.isArray(entry.reasons)
      ? entry.reasons.filter((reason): reason is string => typeof reason === "string")
      : [];
    const common = {
      number,
      title,
      url: entry.url ?? null,
      baseBranch: entry.baseBranch ?? null,
      headBranch: entry.headBranch ?? null,
      reasons,
    };
    if (state === "needs-reconciliation") {
      return [
        {
          kind: "pr-reconcile",
          priority: 0,
          key: `pr:${String(number).padStart(8, "0")}`,
          summary: `Reconcile PR #${number}: ${title}`,
          source: common,
        },
      ];
    }
    if (state === "refresh-recommended") {
      return [
        {
          kind: "pr-refresh",
          priority: 5,
          key: `pr:${String(number).padStart(8, "0")}`,
          summary: `Refresh PR #${number}: ${title}`,
          source: common,
        },
      ];
    }
    return [
      {
        kind: "pr-review",
        priority: 10,
        key: `pr:${String(number).padStart(8, "0")}`,
        summary: `Review and integrate PR #${number}: ${title}`,
        source: common,
      },
    ];
  });
  return { candidates, source };
}

function roadmapCandidates(root: string): NextSliceCandidate[] {
  const paths = walkFiles(root, 6)
    .filter((path) => {
      const relative = relativePosix(root, path).toLowerCase();
      return relative.endsWith(".md") && /(^|\/)roadmap(?:[^/]*)\.md$/.test(relative);
    })
    .sort();
  const candidates: NextSliceCandidate[] = [];
  for (const path of paths) {
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((line, index) => {
      const match = line.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
      if (!match) return;
      const relative = relativePosix(root, path);
      const summary = match[1]!.trim();
      candidates.push({
        kind: "roadmap",
        priority: 20,
        key: `roadmap:${relative}:${String(index + 1).padStart(6, "0")}`,
        summary,
        source: { path: relative, line: index + 1 },
      });
    });
  }
  return candidates;
}

function issueCandidates(
  root: string,
  runner: Runner,
): { candidates: NextSliceCandidate[]; diagnostic?: Diagnostic } {
  const metadata = readRepositoryMetadata(root);
  const repository = metadata.metadata?.id;
  if (!repository) {
    return {
      candidates: [],
      diagnostic: {
        code: "next-slice-issues-unavailable",
        message: "Repository metadata does not provide a GitHub repository id",
      },
    };
  }
  const command = runner(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,updatedAt,labels",
    ],
    root,
  );
  const issues = parseJson<IssueInfo[]>(command);
  if (!Array.isArray(issues)) {
    return {
      candidates: [],
      diagnostic: {
        code: "next-slice-issues-unavailable",
        message:
          command.stderr.trim() || command.error || `Could not list open issues for ${repository}`,
      },
    };
  }
  return {
    candidates: issues.flatMap((issue): NextSliceCandidate[] => {
      const number = Number(issue.number);
      const title = typeof issue.title === "string" ? issue.title.trim() : "";
      if (!Number.isInteger(number) || number <= 0 || !title) return [];
      return [
        {
          kind: "issue",
          priority: 30,
          key: `issue:${String(number).padStart(8, "0")}`,
          summary: `Issue #${number}: ${title}`,
          source: {
            number,
            url: typeof issue.url === "string" ? issue.url : null,
            updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : null,
            labels: Array.isArray(issue.labels) ? issue.labels : [],
          },
        },
      ];
    }),
  };
}

const slashTodoExtensions = new Set([".cs", ".js", ".jsx", ".mjs", ".rs", ".ts", ".tsx"]);
const hashTodoExtensions = new Set([".toml", ".yml", ".yaml"]);

function todoCommentPattern(path: string): RegExp | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = name.slice(dot).toLowerCase();
  if (slashTodoExtensions.has(extension)) {
    return /^\s*\/\/\s*TODO(?:\(#(\d+)\))?:\s*(.+?)\s*$/;
  }
  if (hashTodoExtensions.has(extension)) {
    return /^\s*#\s*TODO(?:\(#(\d+)\))?:\s*(.+?)\s*$/;
  }
  return undefined;
}

function todoCandidates(root: string): NextSliceCandidate[] {
  const candidates: NextSliceCandidate[] = [];
  const files = walkFiles(root, 8)
    .filter((path) => {
      const relative = relativePosix(root, path);
      if (relative.startsWith(".conventions/") || relative.startsWith(".artifacts/")) return false;
      return todoCommentPattern(path) !== undefined;
    })
    .sort();
  for (const path of files) {
    const pattern = todoCommentPattern(path);
    if (!pattern) continue;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((line, index) => {
      const match = line.match(pattern);
      if (!match || !match[2]!.trim()) return;
      const relative = relativePosix(root, path);
      candidates.push({
        kind: "todo",
        priority: 40,
        key: `todo:${relative}:${String(index + 1).padStart(6, "0")}`,
        summary: match[2]!.trim(),
        source: {
          path: relative,
          line: index + 1,
          issue: match[1] ? Number(match[1]) : null,
        },
      });
    });
  }
  return candidates;
}

function capabilityGapCandidates(root: string): {
  candidates: NextSliceCandidate[];
  source: ResultEnvelope<Record<string, unknown>>;
} {
  const source = remediationPlanCommand(root);
  const entries = Array.isArray(source.data.candidates)
    ? (source.data.candidates as Array<Record<string, unknown>>)
    : [];
  return {
    source,
    candidates: entries.map((entry, index) => ({
      kind: "capability-gap" as const,
      priority: 50 + index,
      key: `gap:${typeof entry.id === "string" ? entry.id : String(index).padStart(6, "0")}`,
      summary:
        typeof entry.summary === "string" ? entry.summary : "Resolve repository capability gap",
      source: entry,
    })),
  };
}

function selectKnownCandidate(
  pr: ReturnType<typeof pullRequestCandidates>,
  roadmap: NextSliceCandidate[],
  issues: ReturnType<typeof issueCandidates>,
  todos: NextSliceCandidate[],
  gaps: ReturnType<typeof capabilityGapCandidates>,
): { selected: NextSliceCandidate | null; blockedBy: string | null } {
  if (pr.source.status !== "passed") return { selected: null, blockedBy: "pull-request-inventory" };
  if (pr.candidates.length > 0) {
    return { selected: rankNextSliceCandidates(pr.candidates)[0] ?? null, blockedBy: null };
  }
  if (roadmap.length > 0) {
    return { selected: rankNextSliceCandidates(roadmap)[0] ?? null, blockedBy: null };
  }
  if (issues.diagnostic) return { selected: null, blockedBy: "issue-inventory" };
  if (issues.candidates.length > 0) {
    return { selected: rankNextSliceCandidates(issues.candidates)[0] ?? null, blockedBy: null };
  }
  if (todos.length > 0) {
    return { selected: rankNextSliceCandidates(todos)[0] ?? null, blockedBy: null };
  }
  if (gaps.source.status !== "passed") {
    return { selected: null, blockedBy: "capability-gap-inventory" };
  }
  return { selected: rankNextSliceCandidates(gaps.candidates)[0] ?? null, blockedBy: null };
}

export function nextSliceCommand(
  repositoryRoot: string,
  dependencies: { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(repositoryRoot);
  const runner = dependencies.run ?? runCommand;
  const pr = pullRequestCandidates(root);
  const roadmap = roadmapCandidates(root);
  const issues = issueCandidates(root, runner);
  const todos = todoCandidates(root);
  const gaps = capabilityGapCandidates(root);
  const candidates = rankNextSliceCandidates([
    ...pr.candidates,
    ...roadmap,
    ...issues.candidates,
    ...todos,
    ...gaps.candidates,
  ]);
  const diagnostics: Diagnostic[] = [];
  if (issues.diagnostic) diagnostics.push(issues.diagnostic);
  diagnostics.push(...pr.source.diagnostics, ...gaps.source.diagnostics);
  const selection = selectKnownCandidate(pr, roadmap, issues, todos, gaps);
  if (selection.blockedBy) {
    diagnostics.push({
      code: "next-slice-higher-priority-source-unavailable",
      message: `Cannot select lower-priority work while ${selection.blockedBy} is unavailable`,
    });
  }
  return {
    schemaVersion: 1,
    operation: "next-slice",
    status: selection.blockedBy ? "unavailable" : selection.selected ? "passed" : "unavailable",
    durationMs: Date.now() - started,
    data: {
      root,
      selected: selection.selected,
      candidates,
      blockedBy: selection.blockedBy,
      sources: {
        pullRequests: { status: pr.source.status, count: pr.candidates.length },
        roadmap: { count: roadmap.length },
        issues: {
          status: issues.diagnostic ? "unavailable" : "passed",
          count: issues.candidates.length,
        },
        todos: { count: todos.length },
        capabilityGaps: { status: gaps.source.status, count: gaps.candidates.length },
      },
      policy: {
        ordering: ["blocking-open-pr", "open-pr", "roadmap", "issue", "todo", "capability-gap"],
        selectionCount: 1,
        mutatesRepository: false,
      },
    },
    diagnostics,
  };
}
