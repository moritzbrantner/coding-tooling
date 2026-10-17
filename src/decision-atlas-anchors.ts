import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  crossRepositoryAnchorPrefix,
  type AtlasAnchor,
  type AtlasIndex,
} from "./decision-atlas.ts";
import { rustDeclarations, type RustItemsResult } from "./rust-items.ts";
import {
  matchTypeScriptSymbol,
  typeScriptSymbols,
  type TypeScriptSymbols,
} from "./typescript-declarations.ts";

export type AnchorStatus = "resolved" | "stale" | "ambiguous" | "unresolved";

/**
 * Report-only resolution of one evidence anchor. `line` and `link` are derived
 * display output for the checked `revision`; they are never anchor identity.
 * A `resolved` anchor proves only that the declaration exists at that revision,
 * not that the described behavior works.
 */
export interface AnchorResolution {
  decisionId: string;
  evidence: string;
  anchor: AtlasAnchor;
  status: AnchorStatus;
  reason?: string;
  revision?: string;
  line?: number;
  link?: string;
}

export interface ResolveAnchorsOptions {
  /** Resolve only anchors of these Decision IDs (in index order). */
  decisionIds?: ReadonlySet<string>;
}

const maxSourceBytes = 2 * 1024 * 1024;
type Language = "rust" | "typescript";

function languageOf(path: string): Language | undefined {
  if (path.endsWith(".rs")) return "rust";
  if (/\.(?:ts|tsx|mts|cts)$/u.test(path)) return "typescript";
  return undefined;
}

type FileRead = { ok: true; text: string } | { ok: false; status: AnchorStatus; reason: string };
type Parsed =
  | { language: "rust"; result: RustItemsResult }
  | { language: "typescript"; result: TypeScriptSymbols };

/** Reads committed git objects only; the working tree is never consulted. */
class GitObjects {
  private readonly commits = new Map<string, boolean>();
  private readonly files = new Map<string, FileRead>();
  private readonly parsed = new Map<string, Parsed>();

  constructor(private readonly root: string) {}

  git(args: string[], maxBuffer = 1024 * 1024): string {
    return execFileSync("git", ["--no-replace-objects", "-C", this.root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  }

  isCommit(sha: string): boolean {
    let known = this.commits.get(sha);
    if (known === undefined) {
      try {
        known = this.git(["cat-file", "-t", sha]).trim() === "commit";
      } catch {
        known = false;
      }
      this.commits.set(sha, known);
    }
    return known;
  }

  read(revision: string, path: string): FileRead {
    const key = revision + ":" + path;
    let file = this.files.get(key);
    if (!file) {
      file = this.load(revision, path);
      this.files.set(key, file);
    }
    return file;
  }

  private load(revision: string, path: string): FileRead {
    const entry = this.git(["ls-tree", "-z", "-l", "--full-tree", revision, "--", path])
      .split("\0")
      .map((line) => line.match(/^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/su))
      .find((match) => match?.[5] === path);
    if (!entry)
      return { ok: false, status: "stale", reason: `file ${path} is not present at ${revision}` };
    const [, mode, type, object, size] = entry;
    if (mode === "120000")
      return {
        ok: false,
        status: "unresolved",
        reason: `${path} is a symbolic link; links are not followed`,
      };
    if (type !== "blob")
      return { ok: false, status: "stale", reason: `${path} is not a file at ${revision}` };
    if (Number(size) > maxSourceBytes)
      return { ok: false, status: "unresolved", reason: `${path} exceeds the 2 MiB source budget` };
    return { ok: true, text: this.git(["cat-file", "blob", object!], maxSourceBytes + 1024) };
  }

  parse(revision: string, path: string, language: Language, text: string): Parsed {
    const key = revision + ":" + path;
    let parsed = this.parsed.get(key);
    if (!parsed) {
      parsed =
        language === "rust"
          ? { language, result: rustDeclarations(text) }
          : { language, result: typeScriptSymbols(path, text) };
      this.parsed.set(key, parsed);
    }
    return parsed;
  }
}

function originRepository(objects: GitObjects): string | undefined {
  try {
    const remote = objects
      .git(["config", "--get", "remote.origin.url"])
      .trim()
      .replace(/^git@github\.com:/u, "https://github.com/")
      .replace(/\.git$/u, "");
    return remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u)?.[1];
  } catch {
    return undefined;
  }
}

/** Lines of exact declaration matches; never substring or comment/string matches. */
function matchLines(anchor: AtlasAnchor, parsed: Parsed): number[] | { reason: string } {
  const symbol = anchor.symbol!;
  if (parsed.language === "rust") {
    if (!parsed.result.ok) return { reason: parsed.result.reason };
    const wanted = symbol.split("::").map((part) => part.replace(/^r#/u, ""));
    return parsed.result.declarations
      .filter(
        (declaration) =>
          (anchor.kind !== "test" || declaration.test) &&
          declaration.path.length === wanted.length &&
          declaration.path.every((part, index) => part === wanted[index]),
      )
      .map((declaration) => declaration.line);
  }
  const symbols = anchor.kind === "test" ? parsed.result.tests : parsed.result.declarations;
  return matchTypeScriptSymbol(symbols, symbol).map((match) => match.line);
}

function resolveAnchor(
  objects: GitObjects,
  repository: string,
  head: string,
  anchor: AtlasAnchor,
): Omit<AnchorResolution, "decisionId" | "evidence" | "anchor"> {
  if (anchor.kind === "proof")
    return {
      status: "unresolved",
      reason:
        "proof URLs are recorded with their immutable revision but never fetched; a proof link is not checked here",
    };
  let path = anchor.path!;
  const other = path.match(crossRepositoryAnchorPrefix);
  if (other) {
    if (other[1] !== repository)
      return {
        status: "unresolved",
        reason: `cross-repository anchor into ${other[1]} is not resolved from ${repository}`,
      };
    path = path.slice(other[0].length);
  }
  const language = languageOf(path);
  if (!language)
    return {
      status: "unresolved",
      reason: `unsupported language for ${path}; only Rust (.rs) and TypeScript (.ts, .tsx, .mts, .cts) are resolved`,
    };
  if (anchor.revision && !objects.isCommit(anchor.revision))
    return {
      status: "unresolved",
      reason: `pinned revision ${anchor.revision} is not a commit in this repository`,
    };
  const revision = anchor.revision ?? head;
  const file = objects.read(revision, path);
  if (!file.ok)
    return file.status === "stale"
      ? { status: "stale", reason: file.reason, revision }
      : { status: file.status, reason: file.reason };
  const lines = matchLines(anchor, objects.parse(revision, path, language, file.text));
  if (!Array.isArray(lines)) return { status: "unresolved", reason: lines.reason };
  const what =
    anchor.kind === "test" ? (language === "rust" ? "#[test] fn" : "test case") : "declaration";
  if (lines.length === 0)
    return {
      status: "stale",
      reason: `no ${what} ${anchor.symbol} in ${path} at ${revision} (renamed, moved or removed)`,
      revision,
    };
  if (lines.length > 1)
    return {
      status: "ambiguous",
      reason: `${lines.length} ${what}s named ${anchor.symbol} in ${path} (lines ${lines.join(", ")})`,
      revision,
    };
  const line = lines[0]!;
  return {
    status: "resolved",
    revision,
    line,
    link: `https://github.com/${repository}/blob/${revision}/${path}#L${line}`,
  };
}

/**
 * Resolves every evidence anchor of `index` against committed git objects of
 * the checkout at `root`: its HEAD, or an anchor's pinned `@<sha>`. One result
 * per anchor in decision, evidence and anchor order. Report-only: the index,
 * its checkboxes, progress and verification state are never changed.
 */
export function resolveAtlasAnchors(
  root: string,
  index: AtlasIndex,
  options: ResolveAnchorsOptions = {},
): AnchorResolution[] {
  const objects = new GitObjects(resolve(root));
  const origin = originRepository(objects);
  if (origin !== index.repository)
    throw new Error(
      `Decision Atlas anchors: checkout origin ${origin ?? "(none)"} is not ${index.repository}`,
    );
  const head = objects.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const results: AnchorResolution[] = [];
  for (const decision of index.decisions) {
    if (options.decisionIds && !options.decisionIds.has(decision.id)) continue;
    for (const evidence of decision.evidence ?? [])
      for (const anchor of evidence.anchors ?? [])
        results.push({
          decisionId: decision.id,
          evidence: evidence.text,
          anchor: { ...anchor },
          ...resolveAnchor(objects, index.repository, head, anchor),
        });
  }
  return results;
}
