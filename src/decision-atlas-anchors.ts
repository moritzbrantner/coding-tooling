import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  crossRepositoryAnchorPrefix,
  type AtlasAnchor,
  type AtlasIndex,
} from "./decision-atlas.ts";
import {
  loadCaseReports,
  runAnchoredTest,
  selectReportExecution,
  type AnchorExecution,
  type CaseReports,
  type RevisionHistory,
} from "./decision-atlas-execution.ts";
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
  /**
   * Which ref `revision` was read from, for a cross-repository anchor that was
   * read: `origin/<default>` (from the sibling's `refs/remotes/origin/HEAD`),
   * `HEAD` when that ref is missing, or `pinned` for an `@<sha>` anchor.
   * Same-repository anchors omit it.
   */
  source?: string;
  line?: number;
  link?: string;
  /**
   * `test:` anchors only: report-only execution evidence from test-case
   * evidence reports or, on request, from running the one anchored test.
   */
  execution?: AnchorExecution;
}

export interface ResolveAnchorsOptions {
  /** Resolve only anchors of these Decision IDs (in index order). */
  decisionIds?: ReadonlySet<string>;
  /**
   * Extra `TestCaseEvidenceArtifact` report files (resolved against `root`), in
   * addition to every `*.json` in `.artifacts/coding-tooling/test-case-evidence/`.
   */
  reports?: readonly string[];
  /**
   * Run the single anchored test for a resolved, unpinned same-repository
   * `test:` anchor that has no current report result. Nothing runs without it.
   */
  runTests?: boolean;
  /** Receives one line per ignored report; defaults to stderr. */
  diagnostic?: (message: string) => void;
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

  private readonly distances = new Map<string, number | undefined>();

  /** Commits reachable from `of` but not from `revision`; undefined unless `revision` is an ancestor. */
  distance(revision: string, of: string): number | undefined {
    if (!/^[0-9a-f]{7,40}$/iu.test(revision)) return undefined;
    const key = revision + ".." + of;
    if (!this.distances.has(key)) {
      let distance: number | undefined;
      try {
        this.git(["merge-base", "--is-ancestor", revision + "^{commit}", of]);
        distance = Number(this.git(["rev-list", "--count", revision + ".." + of]).trim());
      } catch {
        distance = undefined;
      }
      this.distances.set(key, distance);
    }
    return this.distances.get(key);
  }

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

/**
 * The `<owner>/<repo>` named by a GitHub remote URL: `https://github.com/o/r`,
 * `git@github.com:o/r` or `ssh://git@github.com/o/r`, `.git` optional.
 */
export function githubRepositoryOf(url: string): string | undefined {
  const normalized = url
    .trim()
    .replace(/^git@github\.com:/iu, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com(?::\d+)?\//iu, "https://github.com/")
    .replace(/\/$/u, "")
    .replace(/\.git$/u, "");
  return normalized.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/iu)?.[1];
}

function originRepository(objects: GitObjects): string | undefined {
  try {
    return githubRepositoryOf(objects.git(["config", "--get", "remote.origin.url"]));
  } catch {
    return undefined;
  }
}

/** Where anchors of one repository are read: the Atlas checkout or a sibling checkout. */
interface AnchorTarget {
  objects: GitObjects;
  repository: string;
  head: string;
  /** Recorded for cross-repository reads only. */
  source?: string;
  /** Names the checkout in reasons, e.g. `../farm-engine`. */
  label?: string;
}

type SiblingTarget = { ok: true; target: AnchorTarget } | { ok: false; reason: string };

function revParse(objects: GitObjects, ref: string): string | undefined {
  try {
    return objects.git(["rev-parse", "-q", "--verify", ref + "^{commit}"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens the sibling checkout `<dirname(root)>/<repo>` of `repository` through
 * git objects only. Nothing is fetched. It counts as `repository` only when it
 * is itself the top level of a git repository whose `remote.origin.url` names
 * `repository` (case-insensitive). Never throws.
 */
function openSibling(root: string, repository: string): SiblingTarget {
  const name = repository.split("/")[1]!;
  const label = "../" + name;
  if (name === "." || name === "..")
    return {
      ok: false,
      reason: `cross-repository anchor into ${repository} has no sibling checkout name`,
    };
  const directory = join(dirname(root), name);
  let isDirectory = false;
  try {
    isDirectory = statSync(directory).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory)
    return {
      ok: false,
      reason: `cross-repository sibling checkout ${label} for ${repository} not found; nothing is fetched`,
    };
  const objects = new GitObjects(directory);
  let topLevel: string | undefined;
  try {
    topLevel = objects.git(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    topLevel = undefined;
  }
  // A plain directory inside some other repository must not borrow that repository.
  if (!topLevel || realpathSync(topLevel) !== realpathSync(directory))
    return {
      ok: false,
      reason: `cross-repository sibling checkout ${label} for ${repository} is not a git repository`,
    };
  let originUrl = "";
  try {
    originUrl = objects.git(["config", "--get", "remote.origin.url"]).trim();
  } catch {
    originUrl = "";
  }
  if (!originUrl)
    return {
      ok: false,
      reason: `cross-repository sibling checkout ${label} has no origin remote, so it is not known to be ${repository}`,
    };
  const origin = githubRepositoryOf(originUrl);
  if (origin?.toLowerCase() !== repository.toLowerCase())
    return {
      ok: false,
      reason: `cross-repository sibling checkout ${label} has origin ${origin ?? originUrl}, not ${repository}`,
    };
  let defaultRef: string | undefined;
  try {
    defaultRef =
      objects.git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).trim() || undefined;
  } catch {
    defaultRef = undefined;
  }
  const defaultBranch = defaultRef?.startsWith("refs/remotes/origin/")
    ? defaultRef.slice("refs/remotes/origin/".length)
    : undefined;
  const defaultHead = defaultBranch ? revParse(objects, defaultRef!) : undefined;
  if (defaultHead)
    return {
      ok: true,
      target: { objects, repository, head: defaultHead, source: "origin/" + defaultBranch, label },
    };
  const head = revParse(objects, "HEAD");
  if (!head)
    return {
      ok: false,
      reason: `cross-repository sibling checkout ${label} for ${repository} has no commit at origin/HEAD or HEAD`,
    };
  return { ok: true, target: { objects, repository, head, source: "HEAD", label } };
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

type ResolutionFields = Omit<AnchorResolution, "decisionId" | "evidence" | "anchor">;

/** The resolution plus the checkout it was read from (absent when no checkout was read). */
interface Resolved {
  fields: ResolutionFields;
  target?: AnchorTarget;
}

function resolveAnchor(
  local: AnchorTarget,
  sibling: (repository: string) => SiblingTarget,
  anchor: AtlasAnchor,
): Resolved {
  let target: AnchorTarget | undefined;
  const fields = resolveFields(local, sibling, anchor, (used) => {
    target = used;
  });
  return { fields, target };
}

function resolveFields(
  local: AnchorTarget,
  sibling: (repository: string) => SiblingTarget,
  anchor: AtlasAnchor,
  used: (target: AnchorTarget) => void,
): ResolutionFields {
  if (anchor.kind === "proof")
    return {
      status: "unresolved",
      reason:
        "proof URLs are recorded with their immutable revision but never fetched; a proof link is not checked here",
    };
  let path = anchor.path!;
  const other = path.match(crossRepositoryAnchorPrefix);
  if (other) path = path.slice(other[0].length);
  const language = languageOf(path);
  if (!language)
    return {
      status: "unresolved",
      reason: `unsupported language for ${path}; only Rust (.rs) and TypeScript (.ts, .tsx, .mts, .cts) are resolved`,
    };
  let target = local;
  if (other && other[1]!.toLowerCase() !== local.repository.toLowerCase()) {
    const opened = sibling(other[1]!);
    if (!opened.ok) return { status: "unresolved", reason: opened.reason };
    target = opened.target;
  }
  used(target);
  const { objects, repository } = target;
  if (anchor.revision && !objects.isCommit(anchor.revision))
    return {
      status: "unresolved",
      reason: `pinned revision ${anchor.revision} is not a commit in ${target.label ? `${target.label} (${repository})` : "this repository"}`,
    };
  const revision = anchor.revision ?? target.head;
  // Only cross-repository reads record their source; same-repository output is unchanged.
  const source =
    target.source === undefined ? undefined : anchor.revision ? "pinned" : target.source;
  const read = (fields: Omit<ResolutionFields, "revision" | "source">): ResolutionFields => {
    const { status, reason, ...rest } = fields;
    return {
      status,
      ...(reason === undefined ? {} : { reason }),
      revision,
      ...(source === undefined ? {} : { source }),
      ...rest,
    };
  };
  const file = objects.read(revision, path);
  if (!file.ok)
    return file.status === "stale"
      ? read({ status: "stale", reason: file.reason })
      : { status: file.status, reason: file.reason };
  const lines = matchLines(anchor, objects.parse(revision, path, language, file.text));
  if (!Array.isArray(lines)) return { status: "unresolved", reason: lines.reason };
  const what =
    anchor.kind === "test" ? (language === "rust" ? "#[test] fn" : "test case") : "declaration";
  if (lines.length === 0)
    return read({
      status: "stale",
      reason: `no ${what} ${anchor.symbol} in ${path} at ${revision} (renamed, moved or removed)`,
    });
  if (lines.length > 1)
    return read({
      status: "ambiguous",
      reason: `${lines.length} ${what}s named ${anchor.symbol} in ${path} (lines ${lines.join(", ")})`,
    });
  const line = lines[0]!;
  return read({
    status: "resolved",
    line,
    link: `https://github.com/${repository}/blob/${revision}/${path}#L${line}`,
  });
}

/**
 * Resolves every evidence anchor of `index` against committed git objects of
 * the checkout at `root`: its HEAD, or an anchor's pinned `@<sha>`. An anchor
 * into another repository `<owner>/<repo>` is read from the sibling checkout
 * `<dirname(root)>/<repo>` at its `origin/<default>` (else HEAD) or the pin, and
 * is `unresolved` with a reason when that checkout is unusable. One result
 * per anchor in decision, evidence and anchor order. Each `test:` result also
 * carries `execution` from test-case evidence reports (and, with `runTests`,
 * from running that one test). Report-only: the index, its checkboxes,
 * progress and verification state are never changed.
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
  const local: AnchorTarget = { objects, repository: index.repository, head };
  const siblings = new Map<string, SiblingTarget>();
  const sibling = (repository: string): SiblingTarget => {
    let opened = siblings.get(repository);
    if (!opened) {
      opened = openSibling(resolve(root), repository);
      siblings.set(repository, opened);
    }
    return opened;
  };
  let reports: CaseReports | undefined;
  const caseReports = (): CaseReports =>
    (reports ??= loadCaseReports(
      resolve(root),
      options.reports ?? [],
      options.diagnostic ?? ((message) => process.stderr.write(message + "\n")),
    ));
  const results: AnchorResolution[] = [];
  for (const decision of index.decisions) {
    if (options.decisionIds && !options.decisionIds.has(decision.id)) continue;
    for (const evidence of decision.evidence ?? [])
      for (const anchor of evidence.anchors ?? []) {
        const { fields, target } = resolveAnchor(local, sibling, anchor);
        const result: AnchorResolution = {
          decisionId: decision.id,
          evidence: evidence.text,
          anchor: { ...anchor },
          ...fields,
        };
        if (anchor.kind === "test")
          result.execution = execution(root, local, anchor, result, target, caseReports(), options);
        results.push(result);
      }
  }
  return results;
}

const noHistory: RevisionHistory = { distance: () => undefined };

/**
 * Execution evidence of one `test:` anchor: the case id is the anchor target as
 * authored without its pin (`<path>::<symbol>`), matched by id and revision only.
 */
function execution(
  root: string,
  local: AnchorTarget,
  anchor: AtlasAnchor,
  result: AnchorResolution,
  target: AnchorTarget | undefined,
  reports: CaseReports,
  options: ResolveAnchorsOptions,
): AnchorExecution {
  const id = anchor.path! + "::" + anchor.symbol!;
  const history = target?.objects ?? noHistory;
  const reported = selectReportExecution(reports.get(id), result.revision, history);
  if (reported.current || !options.runTests) return reported;
  // Running covers only resolved, unpinned anchors in this checkout (cross-repository
  // and pinned test anchors are out of scope).
  if (result.status !== "resolved" || anchor.revision || target !== local) return reported;
  const path = anchor.path!.replace(crossRepositoryAnchorPrefix, "");
  const ran = runAnchoredTest(resolve(root), local.head, path, anchor.symbol!);
  return ran.status === "not-run" ? reported : ran;
}
