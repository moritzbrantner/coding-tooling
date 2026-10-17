#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveAtlasAnchors, type AnchorResolution } from "./decision-atlas-anchors.ts";
import { indexRepository } from "./decision-atlas-cli.ts";
import {
  supportedAtlasIndexSchemaVersions,
  validateAtlasIndex,
  type AtlasFormat,
  type AtlasIndex,
} from "./decision-atlas.ts";
import { queryDecisionAtlas, type DaqAction, type DaqKind, type DaqResult } from "./daq.ts";

const usage = [
  "Usage: daq get <id> [--root <checkout> | --index <index.json>]",
  "       daq find <words> [--topic <name-or-ID>] [--kind all|decision|question]",
  "       daq list [--topic <name-or-ID>] [--kind all|decision|question]",
  "       daq questions [--topic <name-or-ID>]",
  "Options: --root <checkout> --source <path> --format numbered-list|my-farm-tree",
  "         --index <index.json|-> --limit <1..100> --include-inactive --json",
  "         --resolve-anchors (report evidence anchors at the checkout's committed HEAD)",
  "Default: query the committed docs/decisions/atlas.md in the current repository;",
  "         results are deterministic, read-only, and limited to 12 entries.",
].join("\n");

interface DaqIo {
  write: (text: string) => void;
  error: (text: string) => void;
}

const stdio: DaqIo = {
  write: (text) => process.stdout.write(text),
  error: (text) => process.stderr.write(text),
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  }).trim();
}

function indexFromCheckout(rootPath: string, source: string, format: AtlasFormat): AtlasIndex {
  const root = resolve(rootPath);
  const remote = git(root, "config", "--get", "remote.origin.url")
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "");
  const match = remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u);
  if (!match) throw new Error("daq: cannot infer GitHub owner/repository from origin; use --index");
  return indexRepository({
    root,
    source,
    format,
    repository: match[1]!,
    revision: git(root, "rev-parse", "HEAD"),
  });
}

function indexFromFile(path: string): AtlasIndex {
  const content = readFileSync(path === "-" ? 0 : resolve(path), "utf8");
  if (Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024)
    throw new Error("daq: index exceeds the 4 MiB input budget");
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object") throw new Error("daq: invalid index");
  const index = parsed as AtlasIndex;
  if (
    // schemaVersion 1 (pre-evidence) indexes stay queryable and report "not-audited".
    !supportedAtlasIndexSchemaVersions.includes(index.schemaVersion) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(index.repository ?? "") ||
    !/^[a-f0-9]{40}$/u.test(index.sourceRevision ?? "") ||
    !Array.isArray(index.decisions) ||
    !Array.isArray(index.groups)
  )
    throw new Error("daq: unsupported or invalid index");
  validateAtlasIndex(index);
  return index;
}

type ResolvedAnchor = NonNullable<
  DaqResult["entries"][number]["evidence"][number]["anchors"]
>[number] & {
  resolution?: Omit<AnchorResolution, "decisionId" | "evidence" | "anchor">;
};

function anchorText(anchor: ResolvedAnchor): string {
  const target =
    anchor.kind === "proof"
      ? anchor.url!
      : anchor.path! + "::" + anchor.symbol! + (anchor.revision ? "@" + anchor.revision : "");
  const resolution = anchor.resolution;
  if (!resolution) return anchor.kind + ": " + target;
  return (
    anchor.kind +
    ": " +
    target +
    " · " +
    resolution.status +
    (resolution.link
      ? " " + resolution.link
      : resolution.reason
        ? " (" + resolution.reason + ")"
        : "")
  );
}

/** Attaches report-only resolutions to the shown entries' anchors; boxes and progress are untouched. */
function attachResolutions(result: DaqResult, resolutions: AnchorResolution[]): void {
  for (const entry of result.entries) {
    const queue = resolutions.filter((resolution) => resolution.decisionId === entry.id);
    let next = 0;
    for (const item of entry.evidence)
      for (const anchor of (item.anchors ?? []) as ResolvedAnchor[]) {
        const { decisionId: _id, evidence: _text, anchor: _anchor, ...resolution } = queue[next++]!;
        anchor.resolution = resolution;
      }
  }
}

function formatText(result: DaqResult): string {
  if (result.shown === 0) return "No matching Atlas entries.\n";
  const lines = [
    String(result.shown) +
      " of " +
      String(result.total) +
      " entries · " +
      result.repository +
      " @ " +
      result.revision.slice(0, 12),
  ];
  for (const entry of result.entries) {
    const label = entry.kind === "question" ? "question" : (entry.status ?? "decision");
    lines.push(entry.id + " [" + label + "] " + (entry.text || "(retired; see source)"));
    lines.push(
      "  " +
        (entry.path.length ? entry.path.join(" > ") + " · " : "") +
        entry.source.path +
        ":" +
        String(entry.source.line),
    );
    if (entry.progress.status === "audited") {
      lines.push(
        "  Implementation evidence: " +
          String(entry.progress.completed) +
          "/" +
          String(entry.progress.total) +
          " child items checked (" +
          String(entry.progress.percent) +
          "%) · each [x] covers only its own item; parent not verified",
      );
      for (const item of entry.evidence) {
        lines.push("    " + (item.checked ? "[x] " : "[ ] ") + item.text);
        for (const anchor of item.anchors ?? []) lines.push("      " + anchorText(anchor));
      }
    } else if (entry.progress.status === "not-audited") {
      lines.push("  Implementation evidence: not audited");
    }
  }
  return lines.join("\n") + "\n";
}

export function daqCommand(argv: string[], io: DaqIo = stdio): number {
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      io.write(usage + "\n");
      return 0;
    }
    const action = argv[0] as DaqAction | undefined;
    if (!action || !["get", "find", "list", "questions"].includes(action)) throw new Error(usage);

    const needsValue = action === "get" || action === "find";
    const value = needsValue ? argv[1] : undefined;
    if (needsValue && (!value || value.startsWith("--"))) throw new Error(usage);

    const options = new Map<string, string>();
    const allowed = new Set([
      "--root",
      "--source",
      "--format",
      "--index",
      "--topic",
      "--kind",
      "--limit",
    ]);
    const flags = new Set(["--json", "--include-inactive", "--resolve-anchors"]);
    for (let i = needsValue ? 2 : 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (flags.has(arg)) {
        if (options.has(arg)) throw new Error("daq: duplicate option " + arg);
        options.set(arg, "true");
        continue;
      }
      if (!allowed.has(arg) || options.has(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--"))
        throw new Error("daq: invalid option " + arg + "\n" + usage);
      options.set(arg, argv[++i]!);
    }
    const rawLimit = options.get("--limit");
    if (rawLimit !== undefined && !/^[1-9]\d*$/u.test(rawLimit))
      throw new Error("daq: limit must be an integer from 1 to 100");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    const kind = (options.get("--kind") ?? "all") as DaqKind;
    const format = (options.get("--format") ?? "numbered-list") as AtlasFormat;
    if (format !== "numbered-list" && format !== "my-farm-tree")
      throw new Error("daq: unsupported source format " + format);

    if (options.has("--resolve-anchors") && options.has("--index"))
      throw new Error(
        "daq: --resolve-anchors reads committed git objects and needs --root, not --index",
      );
    const root = options.get("--root") ?? process.cwd();
    const index = options.has("--index")
      ? indexFromFile(options.get("--index")!)
      : indexFromCheckout(root, options.get("--source") ?? "docs/decisions/atlas.md", format);
    const result = queryDecisionAtlas(index, {
      action,
      value,
      topic: options.get("--topic"),
      kind,
      limit,
      includeInactive: options.has("--include-inactive"),
    });
    if (options.has("--resolve-anchors"))
      attachResolutions(
        result,
        resolveAtlasAnchors(root, index, {
          decisionIds: new Set(result.entries.map((entry) => entry.id)),
        }),
      );
    io.write(options.has("--json") ? JSON.stringify(result, null, 2) + "\n" : formatText(result));
    return 0;
  } catch (error) {
    io.error((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exitCode = daqCommand(process.argv.slice(2));
