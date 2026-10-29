import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import { runCommand } from "./shared.ts";

export const hotspotsSchemaVersion = "coding-tooling/hotspots/v1";

export type HotspotOptions = {
  /** Churn window in days (default 21). */
  days?: number;
  /** Minimum commits touching a file inside the window to count as high churn (default 5). */
  minCommits?: number;
  /** Line count above which a tracked text file is large (default 800). */
  minLines?: number;
  /** Maximum entries per list (default 25). */
  limit?: number;
};

export type HotspotFile = { path: string; commits: number; lines: number };

export type HotspotsData = {
  schemaVersion: typeof hotspotsSchemaVersion;
  root: string;
  window: { days: number; commits: number };
  thresholds: { minCommits: number; minLines: number };
  /** Files over both thresholds: the usual first refactor candidates. */
  hotspots: HotspotFile[];
  churn: HotspotFile[];
  large: HotspotFile[];
  limitations: string[];
};

// Generated or vendored files whose size or churn says nothing about the code.
const ignored =
  /(?:^|\/)(?:[\w.-]+\.lock|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|go\.sum|[\w.-]+\.min\.[jc]ss?|[\w.-]+\.(?:snap|svg|map))$/u;

function lineCount(root: string, path: string): number {
  let content: Buffer;
  try {
    content = readFileSync(join(root, path));
  } catch {
    return 0;
  }
  // Binary (or LFS-smudged binary) content has no meaningful line count.
  if (content.subarray(0, 8000).includes(0)) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  return content.length > 0 && content.at(-1) !== 10 ? lines + 1 : lines;
}

function byWeight(left: HotspotFile, right: HotspotFile): number {
  return (
    right.commits * right.lines - left.commits * left.lines ||
    right.commits - left.commits ||
    right.lines - left.lines ||
    left.path.localeCompare(right.path)
  );
}

/**
 * Read-only refactor evidence from git history and the working tree: files changed in many commits
 * inside a recent window, files over a line threshold, and their intersection.
 */
export function hotspotEvidence(
  root: string,
  options: HotspotOptions = {},
): ResultEnvelope<HotspotsData> {
  const started = Date.now();
  const days = options.days ?? 21;
  const minCommits = options.minCommits ?? 5;
  const minLines = options.minLines ?? 800;
  const limit = options.limit ?? 25;
  const diagnostics: Diagnostic[] = [];
  const data: HotspotsData = {
    schemaVersion: hotspotsSchemaVersion,
    root,
    window: { days, commits: 0 },
    thresholds: { minCommits, minLines },
    hotspots: [],
    churn: [],
    large: [],
    limitations: [
      "Churn counts non-merge commits on the current HEAD that touched each path; renames are counted under the new path only.",
      "Lock files, snapshots, source maps, minified bundles, SVG and binary files are excluded.",
    ],
  };
  const tracked = runCommand("git", ["ls-files", "-z"], root);
  if (tracked.status !== 0) {
    diagnostics.push({
      code: "hotspots-git-unavailable",
      message: `git ls-files failed: ${(tracked.error ?? tracked.stderr).trim()}`,
    });
    return {
      schemaVersion: 1,
      operation: "hotspots",
      status: "unavailable",
      durationMs: Date.now() - started,
      data,
      diagnostics,
    };
  }
  const files = tracked.stdout.split("\0").filter((path) => path && !ignored.test(path));
  const log = runCommand(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--no-merges",
      `--since=${days}.days`,
      "--name-only",
      "--format=%x00",
    ],
    root,
  );
  const commits = new Map<string, number>();
  if (log.status === 0) {
    const entries = log.stdout.split("\0").slice(1);
    data.window.commits = entries.length;
    for (const entry of entries)
      for (const path of new Set(entry.split("\n").filter(Boolean)))
        commits.set(path, (commits.get(path) ?? 0) + 1);
  } else {
    diagnostics.push({
      code: "hotspots-history-unavailable",
      message: `git log failed; churn is empty: ${(log.error ?? log.stderr).trim()}`,
    });
  }
  const measured = files.map((path) => ({
    path,
    commits: commits.get(path) ?? 0,
    lines: lineCount(root, path),
  }));
  const churn = measured.filter((file) => file.commits >= minCommits);
  const large = measured.filter((file) => file.lines > minLines);
  data.hotspots = churn
    .filter((file) => file.lines > minLines)
    .sort(byWeight)
    .slice(0, limit);
  data.churn = churn
    .sort((left, right) => right.commits - left.commits || byWeight(left, right))
    .slice(0, limit);
  data.large = large
    .sort((left, right) => right.lines - left.lines || byWeight(left, right))
    .slice(0, limit);
  return {
    schemaVersion: 1,
    operation: "hotspots",
    status: "passed",
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

/** Plain-text table for `--json`-less runs. */
export function formatHotspots(data: HotspotsData): string {
  const section = (title: string, rows: HotspotFile[]) =>
    [
      `${title} (${rows.length})`,
      ...(rows.length === 0
        ? ["  none"]
        : rows.map(
            (row) =>
              `  ${String(row.commits).padStart(4)} commits  ${String(row.lines).padStart(6)} lines  ${row.path}`,
          )),
    ].join("\n");
  return [
    `Hotspots in ${data.root}: last ${data.window.days} days, ${data.window.commits} commits; churn >= ${data.thresholds.minCommits} commits, large > ${data.thresholds.minLines} lines.`,
    section("Churn and large", data.hotspots),
    section("High churn", data.churn),
    section("Large files", data.large),
  ].join("\n\n");
}
