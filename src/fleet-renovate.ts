// Read-only Renovate health report across the fleet (moritzbrantner/coding-tooling#330).
//
// The report only reads GitHub through `gh` and never merges, approves, labels or pushes
// anything. It is informational: pending updates, failing bot PRs and missing configuration are
// reported as recommended actions, never as a failed status. Only unreadable GitHub data makes
// the report `unavailable`.
import { resolve } from "node:path";

import { fleetAuthorityGraph } from "./fleet-authority-graph.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { type CommandResult, runCommand } from "./shared.ts";

export const FLEET_RENOVATE_VERSION = "coding-tooling/fleet-renovate/v1" as const;
export const CENTRAL_PRESET = "github>moritzbrantner/coding-agent-conventions";
/** Left out of fleet enumeration by default. Another session owns the mmorpg checkout. */
export const DEFAULT_EXCLUDED_REPOSITORIES = ["moritzbrantner/mmorpg"] as const;
/** Probed in Renovate's own lookup order; the first file found is the configuration. */
export const RENOVATE_CONFIG_PATHS = [
  "renovate.json",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
] as const;
const STALE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_TITLE = /dependency dashboard/i;

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export type FleetRenovateOptions = {
  /** `--repo owner/name`, repeatable; replaces fleet enumeration. */
  repositories?: string[];
  run?: Runner;
  now?: Date;
};

export type DashboardItem = { branch: string; title: string };
export type ChecksState = "passing" | "failing" | "pending" | "none";
export type RenovatePullRequest = {
  number: number;
  title: string;
  ageDays: number;
  checks: ChecksState;
};
export type RenovateActionKind =
  | "add-config"
  | "extend-central-preset"
  | "owner-install-app"
  | "approve-majors-in-dashboard"
  | "fix-failing-renovate-pr"
  | "stale-pr";
export type RenovateAction = {
  kind: RenovateActionKind;
  owner: boolean;
  message: string;
  pullRequest?: number;
};
export type RenovateConfigState = {
  present: boolean;
  path: string | null;
  extendsCentralPreset: boolean;
};
export type RenovateAppState = "installed" | "unknown" | "needs-config";
export type FleetRenovateEntry = {
  repository: string;
  config: RenovateConfigState;
  app: RenovateAppState;
  dashboard: {
    issue: number | null;
    awaitingSchedule: DashboardItem[];
    pendingApproval: DashboardItem[];
    pendingStatusChecks: DashboardItem[];
    openPrs: RenovatePullRequest[];
  };
  actions: RenovateAction[];
};

class ReadFailure extends Error {}

function failureMessage(repository: string, what: string, result: CommandResult): string {
  const detail = (result.stderr || result.error || result.stdout).trim() || `exit ${result.status}`;
  return `${repository}: could not read ${what}: ${detail}`;
}

function isNotFound(result: CommandResult): boolean {
  return result.status !== 0 && /HTTP 404|Not Found/.test(result.stderr);
}

function readJson<T>(repository: string, what: string, result: CommandResult): T {
  if (result.status !== 0) throw new ReadFailure(failureMessage(repository, what, result));
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new ReadFailure(`${repository}: could not parse ${what} as JSON`);
  }
}

/** True for the preset itself or one of its sub-presets (`:name`, `//path`, `#ref`, `(args)`). */
function isCentralPreset(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith(CENTRAL_PRESET)) return false;
  const next = value.charAt(CENTRAL_PRESET.length);
  return next === "" || next === ":" || next === "/" || next === "#" || next === "(";
}

/**
 * Removes `//` and block comments and trailing commas outside strings, which covers the JSON5
 * that Renovate configs use in practice. Anything else (unquoted keys, single quotes) still fails
 * JSON.parse and falls back to the preset regex.
 */
function stripJson5(source: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      output += char;
      if (char === "\\") {
        output += source[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 1;
    } else if (char === ",") {
      const rest = /^\s*([}\]])/.exec(source.slice(index + 1));
      if (!rest) output += char;
    } else output += char;
  }
  return output;
}

function extendsCentralPreset(text: string): boolean {
  for (const candidate of [text, stripJson5(text)]) {
    try {
      const parsed = JSON.parse(candidate) as { extends?: unknown };
      return Array.isArray(parsed?.extends) && parsed.extends.some(isCentralPreset);
    } catch {
      // Try the next, more tolerant form.
    }
  }
  // Unparseable (for example full JSON5): look for the preset as a quoted string.
  const escaped = CENTRAL_PRESET.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`["']${escaped}(?:["':#(]|/)`).test(text);
}

function readConfig(repository: string, run: Runner, cwd: string): RenovateConfigState {
  for (const path of RENOVATE_CONFIG_PATHS) {
    const result = run(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/${repository}/contents/${path}`,
      ],
      cwd,
    );
    if (isNotFound(result)) continue;
    if (result.status !== 0) {
      throw new ReadFailure(failureMessage(repository, `Renovate config ${path}`, result));
    }
    return { present: true, path, extendsCentralPreset: extendsCentralPreset(result.stdout) };
  }
  return { present: false, path: null, extendsCentralPreset: false };
}

type IssueInfo = { number?: unknown; title?: unknown; body?: unknown; author?: unknown };
type PullInfo = {
  number?: unknown;
  title?: unknown;
  createdAt?: unknown;
  statusCheckRollup?: unknown;
};

function isRenovateAuthor(author: unknown): boolean {
  const login = (author as { login?: unknown } | null)?.login;
  return login === "app/renovate" || login === "renovate[bot]" || login === "renovate";
}

const SECTIONS = {
  "pending approval": "pendingApproval",
  "awaiting schedule": "awaitingSchedule",
  "pending status checks": "pendingStatusChecks",
} as const;

/** Tolerant Dependency Dashboard parser. Unknown sections and lines are ignored. */
export function parseDashboard(body: string): {
  awaitingSchedule: DashboardItem[];
  pendingApproval: DashboardItem[];
  pendingStatusChecks: DashboardItem[];
} {
  const parsed = {
    awaitingSchedule: [] as DashboardItem[],
    pendingApproval: [] as DashboardItem[],
    pendingStatusChecks: [] as DashboardItem[],
  };
  let section: keyof typeof parsed | undefined;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{2,}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = SECTIONS[heading[1]!.toLowerCase() as keyof typeof SECTIONS];
      continue;
    }
    if (!section) continue;
    // Item lines carry `<!-- action=branch -->`; aggregate lines have no `=branch` and are skipped.
    const item = /^\s*[-*]\s*\[[ xX]\]\s*<!--\s*[\w-]+=(\S+?)\s*-->\s*(.*?)\s*$/.exec(line);
    if (item && item[2]) parsed[section].push({ branch: item[1]!, title: item[2] });
  }
  return parsed;
}

const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export function checksState(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let failing = false;
  let pending = false;
  for (const raw of rollup) {
    const check = (raw ?? {}) as Record<string, unknown>;
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const state = String(check.state ?? "").toUpperCase();
    if (check["__typename"] === "StatusContext" || (!check["__typename"] && state)) {
      if (state === "FAILURE" || state === "ERROR") failing = true;
      else if (state === "PENDING" || state === "EXPECTED") pending = true;
    } else {
      if (FAILING_CONCLUSIONS.has(conclusion)) failing = true;
      else if (String(check.status ?? "").toUpperCase() !== "COMPLETED") pending = true;
    }
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

function reportRepository(
  repository: string,
  run: Runner,
  cwd: string,
  now: Date,
): FleetRenovateEntry {
  const config = readConfig(repository, run, cwd);

  // Real gh quirk: `--author app/renovate` matches no issues; `renovate[bot]` does.
  const issues = readJson<IssueInfo[]>(
    repository,
    "Dependency Dashboard issues",
    run(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--author",
        "renovate[bot]",
        "--limit",
        "50",
        "--json",
        "number,title,body,author",
      ],
      cwd,
    ),
  );
  const dashboardIssue = (Array.isArray(issues) ? issues : [])
    .filter(
      (issue) =>
        Number.isInteger(issue.number) &&
        typeof issue.title === "string" &&
        DASHBOARD_TITLE.test(issue.title) &&
        isRenovateAuthor(issue.author),
    )
    .toSorted((left, right) => Number(left.number) - Number(right.number))[0];

  const pulls = readJson<PullInfo[]>(
    repository,
    "Renovate pull requests",
    run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--author",
        "app/renovate",
        "--limit",
        "100",
        "--json",
        "number,title,createdAt,statusCheckRollup",
      ],
      cwd,
    ),
  );
  const openPrs: RenovatePullRequest[] = (Array.isArray(pulls) ? pulls : [])
    .filter((pull) => Number.isInteger(pull.number))
    .map((pull) => {
      const created = Date.parse(String(pull.createdAt ?? ""));
      return {
        number: Number(pull.number),
        title: typeof pull.title === "string" ? pull.title : "",
        ageDays: Number.isNaN(created)
          ? 0
          : Math.max(0, Math.floor((now.getTime() - created) / DAY_MS)),
        checks: checksState(pull.statusCheckRollup),
      };
    })
    .toSorted((left, right) => left.number - right.number);

  let installed = dashboardIssue !== undefined || openPrs.length > 0;
  if (!installed) {
    const refs = run("gh", ["api", `repos/${repository}/git/matching-refs/heads/renovate`], cwd);
    if (!isNotFound(refs)) {
      const listed = readJson<Array<{ ref?: unknown }>>(repository, "renovate/* branches", refs);
      installed = (Array.isArray(listed) ? listed : []).some(
        (ref) => typeof ref.ref === "string" && ref.ref.startsWith("refs/heads/renovate/"),
      );
    }
  }
  const app: RenovateAppState = installed
    ? "installed"
    : config.present
      ? "unknown"
      : "needs-config";

  const parsed = parseDashboard(
    dashboardIssue && typeof dashboardIssue.body === "string" ? dashboardIssue.body : "",
  );
  const actions: RenovateAction[] = [];
  if (!config.present) {
    actions.push({
      kind: "add-config",
      owner: false,
      message: `Add a minimal renovate.json that extends ${CENTRAL_PRESET} through the repository's normal PR flow.`,
    });
  } else if (!config.extendsCentralPreset) {
    actions.push({
      kind: "extend-central-preset",
      owner: false,
      message: `Make ${config.path} extend ${CENTRAL_PRESET} through the repository's normal PR flow.`,
    });
  }
  if (app === "unknown") {
    actions.push({
      kind: "owner-install-app",
      owner: true,
      message:
        "Renovate config is present but there is no Renovate activity; check that the Renovate app is installed for this repository (owner action).",
    });
  }
  if (parsed.pendingApproval.length > 0) {
    actions.push({
      kind: "approve-majors-in-dashboard",
      owner: true,
      message: `${parsed.pendingApproval.length} update(s) await approval in Dependency Dashboard #${String(dashboardIssue?.number)}; review and approve them there.`,
    });
  }
  for (const pull of openPrs) {
    if (pull.checks === "failing") {
      actions.push({
        kind: "fix-failing-renovate-pr",
        owner: false,
        message: `Renovate PR #${pull.number} has failing checks.`,
        pullRequest: pull.number,
      });
    }
    if (pull.ageDays > STALE_AFTER_DAYS) {
      actions.push({
        kind: "stale-pr",
        owner: false,
        message: `Renovate PR #${pull.number} has been open for ${pull.ageDays} days.`,
        pullRequest: pull.number,
      });
    }
  }

  return {
    repository,
    config,
    app,
    dashboard: {
      issue: dashboardIssue ? Number(dashboardIssue.number) : null,
      ...parsed,
      openPrs,
    },
    actions,
  };
}

/** `owner/name` from a GitHub origin URL (ssh or https), or undefined. */
export function repositoryFromOrigin(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function enumerateFleet(
  root: string,
  run: Runner,
  diagnostics: Diagnostic[],
): { repositories: string[]; excluded: string[] } {
  const ids = new Set<string>();
  const graph = fleetAuthorityGraph(root);
  const checkouts = (graph.data.repositories ?? []) as Array<{
    root: string;
    metadata: { id?: unknown } | null;
  }>;
  for (const checkout of checkouts) {
    let id = typeof checkout.metadata?.id === "string" ? checkout.metadata.id : undefined;
    if (!id) {
      // cwd, not `-C <path>`, so excluded checkouts never appear in the command line.
      const origin = run("git", ["config", "--get", "remote.origin.url"], checkout.root);
      id = origin.status === 0 ? repositoryFromOrigin(origin.stdout) : undefined;
    }
    if (id) ids.add(id);
    else {
      diagnostics.push({
        code: "fleet-renovate-repository-unidentified",
        message: "Checkout has no .repository.toml id and no GitHub origin; it is not reported.",
        path: checkout.root,
      });
    }
  }
  const excludedSet = new Set<string>(DEFAULT_EXCLUDED_REPOSITORIES);
  return {
    repositories: [...ids].filter((id) => !excludedSet.has(id)),
    excluded: [...ids].filter((id) => excludedSet.has(id)).toSorted(),
  };
}

export function fleetRenovateReport(
  fleetRoot: string,
  options: FleetRenovateOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(fleetRoot);
  const run = options.run ?? runCommand;
  const now = options.now ?? new Date();
  const diagnostics: Diagnostic[] = [];

  // An explicit --repo list is taken as given, including a repository excluded by default.
  const selection = options.repositories
    ? { repositories: [...new Set(options.repositories)], excluded: [] as string[] }
    : enumerateFleet(root, run, diagnostics);

  let status: ResultStatus = "passed";
  const repositories: FleetRenovateEntry[] = [];
  const unavailable: string[] = [];
  for (const repository of selection.repositories.toSorted()) {
    try {
      repositories.push(reportRepository(repository, run, root, now));
    } catch (error) {
      if (!(error instanceof ReadFailure)) throw error;
      status = "unavailable";
      unavailable.push(repository);
      diagnostics.push({ code: "fleet-renovate-github-unavailable", message: error.message });
    }
  }

  return {
    schemaVersion: 1,
    operation: "fleet-renovate",
    status,
    durationMs: Date.now() - started,
    data: {
      schemaVersion: FLEET_RENOVATE_VERSION,
      root,
      centralPreset: CENTRAL_PRESET,
      repositories,
      excluded: selection.excluded,
      unavailable,
      notes: [
        "Read-only and informational: pending updates, failing bot PRs and missing config are actions, not failures.",
        "Major updates keep Dependency Dashboard approval; the report recommends approving and never approves.",
      ],
    },
    diagnostics,
  };
}
