/**
 * Independent acceptance for moritzbrantner/coding-tooling#341:
 * Decision Atlas evidence anchors that name ANOTHER repository
 * (`<owner>/<repo>:<path>::<symbol>[@<40-hex>]`) are resolved against a local
 * sibling checkout, following owner decisions 4.3.6 (issue comment of
 * 2026-10-17). Atlas Question 4.2.1 (index synchronization) stays open and is
 * deliberately not tested here.
 *
 * Pinned seam (a minimal extension of the #323 resolution element):
 *
 *   resolveAtlasAnchors(root, index) keeps its signature and its one result per
 *   anchor. `AnchorResolution` gains ONE optional field:
 *
 *     source?: string   // which ref the `revision` was read from
 *
 *   For a cross-repository anchor that was read (resolved | stale | ambiguous):
 *     - "origin/<default>" (e.g. "origin/trunk") when the sibling has
 *       `refs/remotes/origin/HEAD`; `<default>` is the branch that symbolic ref
 *       points to (never a hard-coded "main"), and `revision` is the 40-hex
 *       commit of `refs/remotes/origin/<default>`.
 *     - "HEAD" when `refs/remotes/origin/HEAD` is missing (even if some other
 *       `refs/remotes/origin/*` exists); `revision` is the sibling's HEAD commit.
 *     - "pinned" when the anchor carries `@<sha>`; `revision` is that sha, which
 *       must be a commit in the SIBLING (an unknown sha is `unresolved`).
 *   Same-repository anchors may omit `source` (or use "HEAD" / "pinned"); they
 *   must never claim an "origin/..." source.
 *
 * Sibling identity: the other repository `<owner>/<repo>` is read from the
 * directory `<dirname(root)>/<repo>` (`../<repo>` next to the Atlas checkout),
 * through git objects only (no working tree, nothing is fetched). It counts as
 * that repository only when it is itself a git repository whose
 * `remote.origin.url` names exactly `<owner>/<repo>` on GitHub (plain name
 * comparison, `.git` suffix optional). Otherwise the anchor is `unresolved`
 * with a non-empty `reason`, never an error:
 *     - the directory is missing (reason names the sibling, e.g. "../farm-engine",
 *       and says checkout/sibling),
 *     - the directory is not a git repository,
 *     - its origin names another repository, or it has no origin remote.
 *   Indexing never fails because of a sibling, and `resolveAtlasAnchors` / `daq`
 *   never throw or exit non-zero because of one.
 *
 * Statuses and parsers are those of #323. A resolved cross-repository anchor
 * links to `https://github.com/<owner>/<repo>/blob/<revision>/<path>#L<line>`
 * where `<path>` excludes the `<owner>/<repo>:` prefix. Non-resolved results
 * carry no line or link. An anchor naming the Atlas's own repository still
 * resolves in-repo at the Atlas HEAD (no sibling is required).
 *
 * CLI: `daq get --resolve-anchors --json` attaches the whole resolution
 * (including `source`) to each anchor.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { daqCommand } from "../src/daq-cli.ts";
import { indexRepository } from "../src/decision-atlas-cli.ts";
import type { AtlasIndex } from "../src/decision-atlas.ts";

const atlasRepository = "moritzbrantner/anchor-fixture";
const otherRepository = "moritzbrantner/farm-engine";
const sourcePath = "docs/decisions/atlas.md";
const engine = "crates/farm/src/engine.rs";
const ovenTest = "tests/oven.test.ts";
const unknownSha = "e".repeat(40);

type Status = "resolved" | "stale" | "ambiguous" | "unresolved";
interface Resolution {
  decisionId: string;
  evidence: string;
  anchor: { kind: string; path?: string; symbol?: string; revision?: string };
  status: Status;
  reason?: string;
  revision?: string;
  source?: string;
  line?: number;
  link?: string;
}

// ---------------------------------------------------------------- sibling content

/** Pinned commit: only legacy_queue and run exist. */
const engineC1 = "pub fn legacy_queue() {}\n\npub fn run() {}\n";
/** origin/trunk: FarmCommand exists, tick was renamed to renamed_tick. */
const engineC2 = `// Engine at the default branch.

pub enum FarmCommand {
    QueueOvenRecipe,
}

pub fn renamed_tick() {}

pub fn run() {}
`;
/** Local HEAD (and the decoy origin/main): FarmCommand removed, head_only added. */
const engineC3 = `pub fn head_only() {}

pub fn run() {}
`;
const ovenTestC2 = `import { describe, it } from "bun:test";

describe("Oven", () => {
  it("bakes bread", () => {});
});
`;
const localTs = "export function localFn(): void {}\n";

function lineOf(text: string, needle: string): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  throw new Error("missing line " + needle);
}

// ---------------------------------------------------------------- fixtures

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Repo {
  root: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (message: string) => string;
}

function repo(root: string, origin: string | undefined, files: Record<string, string>): Repo {
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, "utf8");
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "work");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Atlas cross-repo acceptance");
  git("config", "user.email", "atlas@example.invalid");
  if (origin) git("remote", "add", "origin", origin);
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit("fixture");
  return { root, git, write, commit };
}

type SiblingKind = "git" | "missing" | "not-git" | "wrong-origin" | "no-origin";

interface World {
  parent: string;
  atlas: Repo;
  sibling?: Repo;
  /** Commits of the sibling: c1 pinned, c2 origin/trunk, c3 HEAD and origin/main. */
  c1: string;
  c2: string;
  c3: string;
  atlasHead: string;
}

function atlasText(pin: string): string {
  const other = otherRepository + ":";
  return `# Cross-repository anchor fixture

## Entries

- **1** Farm
  - **1.1** Engine
    - **1.1.1** [decision] The client relies on the farm engine.
      - [x] Cross enum variant — src: ${other}${engine}::FarmCommand::QueueOvenRecipe
      - [x] Cross TS test — test: ${other}${ovenTest}::Oven > bakes bread
      - [ ] Head only — src: ${other}${engine}::head_only
      - [ ] Renamed tick — src: ${other}${engine}::tick
      - [x] Pinned legacy — src: ${other}${engine}::legacy_queue@${pin}
      - [ ] Unknown pin — src: ${other}${engine}::run@${unknownSha}
      - [ ] Draft — src: ${other}${engine}::draft
      - [ ] Own repository by name — src: ${atlasRepository}:src/local.ts::localFn
      - [ ] Local plain — src: src/local.ts::localFn
`;
}

function world(kind: SiblingKind = "git", originHead = true): World {
  const parent = mkdtempSync(join(tmpdir(), "atlas-cross-repo-"));
  directories.push(parent);
  const siblingRoot = join(parent, "farm-engine");
  let sibling: Repo | undefined;
  let c1 = "c".repeat(40);
  let c2 = c1;
  let c3 = c1;
  if (kind === "not-git") {
    mkdirSync(join(siblingRoot, dirname(engine)), { recursive: true });
    writeFileSync(join(siblingRoot, engine), engineC2, "utf8");
  } else if (kind !== "missing") {
    const origin =
      kind === "wrong-origin"
        ? "https://github.com/someone-else/farm-engine.git"
        : kind === "no-origin"
          ? undefined
          : `https://github.com/${otherRepository}.git`;
    sibling = repo(siblingRoot, origin, { [engine]: engineC1 });
    c1 = sibling.git("rev-parse", "HEAD");
    sibling.write(engine, engineC2);
    sibling.write(ovenTest, ovenTestC2);
    c2 = sibling.commit("default branch");
    sibling.write(engine, engineC3);
    c3 = sibling.commit("local work");
    sibling.git("update-ref", "refs/remotes/origin/trunk", c2);
    // Decoy: an implementation that hard-codes origin/main reads the wrong commit.
    sibling.git("update-ref", "refs/remotes/origin/main", c3);
    if (originHead)
      sibling.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  }
  const atlas = repo(join(parent, "atlas-checkout"), `https://github.com/${atlasRepository}.git`, {
    "src/local.ts": localTs,
    [sourcePath]: atlasText(c1),
  });
  return { parent, atlas, sibling, c1, c2, c3, atlasHead: atlas.git("rev-parse", "HEAD") };
}

function indexAt(w: World): AtlasIndex {
  return indexRepository({
    root: w.atlas.root,
    repository: atlasRepository,
    source: sourcePath,
    format: "numbered-list",
    revision: w.atlasHead,
  });
}

// Computed specifier, as in the #323 acceptance file.
const anchorsModule = "../src/decision-atlas-anchors.ts";
async function resolveAll(w: World): Promise<Resolution[]> {
  const mod = (await import(anchorsModule)) as {
    resolveAtlasAnchors: (root: string, index: AtlasIndex) => Resolution[] | Promise<Resolution[]>;
  };
  return await mod.resolveAtlasAnchors(w.atlas.root, indexAt(w));
}

function result(results: Resolution[], evidence: string): Resolution {
  const matches = results.filter((r) => r.evidence === evidence);
  if (matches.length !== 1)
    throw new Error(`expected one result for ${evidence}, got ${matches.length}`);
  return matches[0]!;
}

function otherLink(revision: string, path: string, line: number): string {
  return `https://github.com/${otherRepository}/blob/${revision}/${path}#L${line}`;
}

function expectRead(
  r: Resolution,
  expected: { status: Status; revision: string; source: string; path?: string; line?: number },
): void {
  const actual = {
    status: r.status,
    revision: r.revision,
    source: r.source,
    line: r.line,
    link: r.link,
  };
  expect(actual).toEqual({
    status: expected.status,
    revision: expected.revision,
    source: expected.source,
    line: expected.line,
    link:
      expected.line === undefined
        ? undefined
        : otherLink(expected.revision, expected.path!, expected.line),
  });
  if (expected.status !== "resolved") expect(r.reason?.trim()).toBeTruthy();
}

function expectUnresolved(r: Resolution, reason: RegExp): void {
  expect({ status: r.status, line: r.line, link: r.link }).toEqual({
    status: "unresolved",
    line: undefined,
    link: undefined,
  });
  expect(r.reason ?? "").toMatch(reason);
}

async function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = await daqCommand(argv, {
    write: (message) => {
      out += message;
    },
    error: (message) => {
      err += message;
    },
  });
  return { code, out, err };
}

const crossEvidence = [
  "Cross enum variant",
  "Cross TS test",
  "Head only",
  "Renamed tick",
  "Pinned legacy",
  "Unknown pin",
  "Draft",
];

// ---------------------------------------------------------------- tests

test("an unpinned anchor resolves at origin/<default> from origin/HEAD and records that source", async () => {
  const w = world();
  const results = await resolveAll(w);
  expectRead(result(results, "Cross enum variant"), {
    status: "resolved",
    revision: w.c2,
    source: "origin/trunk",
    path: engine,
    line: lineOf(engineC2, "QueueOvenRecipe"),
  });
  // Same TypeScript test parser, joined describe path.
  expectRead(result(results, "Cross TS test"), {
    status: "resolved",
    revision: w.c2,
    source: "origin/trunk",
    path: ovenTest,
    line: lineOf(ovenTestC2, "bakes bread"),
  });
  // head_only exists at the sibling's HEAD and at the decoy origin/main, not at origin/trunk.
  expectRead(result(results, "Head only"), {
    status: "stale",
    revision: w.c2,
    source: "origin/trunk",
  });
});

test("a renamed symbol in the sibling is stale at the recorded revision", async () => {
  const w = world();
  const results = await resolveAll(w);
  const renamed = result(results, "Renamed tick");
  expectRead(renamed, { status: "stale", revision: w.c2, source: "origin/trunk" });
  expect(renamed.reason).toContain("tick");
});

test("without origin/HEAD the sibling's HEAD is read, even when origin/main exists", async () => {
  const w = world("git", false);
  const results = await resolveAll(w);
  expectRead(result(results, "Head only"), {
    status: "resolved",
    revision: w.c3,
    source: "HEAD",
    path: engine,
    line: lineOf(engineC3, "head_only"),
  });
  expectRead(result(results, "Cross enum variant"), {
    status: "stale",
    revision: w.c3,
    source: "HEAD",
  });
});

test("a pinned @sha is read at that sibling commit; a sha unknown to the sibling is unresolved", async () => {
  const w = world();
  // The pinned commit exists only in the sibling, not in the Atlas checkout.
  expect(() => w.atlas.git("cat-file", "-t", w.c1)).toThrow();
  const results = await resolveAll(w);
  expectRead(result(results, "Pinned legacy"), {
    status: "resolved",
    revision: w.c1,
    source: "pinned",
    path: engine,
    line: lineOf(engineC1, "legacy_queue"),
  });
  expectUnresolved(result(results, "Unknown pin"), /revision|commit|sha/iu);
});

test("the sibling's working-tree edits and untracked files are ignored", async () => {
  const w = world("git", false);
  w.sibling!.write(engine, "pub fn draft() {}\n");
  w.sibling!.write("crates/farm/src/untracked.rs", "pub fn draft() {}\n");
  const results = await resolveAll(w);
  expectRead(result(results, "Draft"), { status: "stale", revision: w.c3, source: "HEAD" });
  expectRead(result(results, "Head only"), {
    status: "resolved",
    revision: w.c3,
    source: "HEAD",
    path: engine,
    line: lineOf(engineC3, "head_only"),
  });
});

test("a missing sibling checkout is unresolved with a reason; indexing and daq still succeed", async () => {
  const w = world("missing");
  const index = indexAt(w);
  expect(index.decisions.some((d) => d.id === "1.1.1")).toBe(true);
  const results = await resolveAll(w);
  for (const evidence of crossEvidence) {
    const r = result(results, evidence);
    expectUnresolved(r, /farm-engine/u);
    expect(r.reason).toMatch(/checkout|sibling/iu);
    expect(r.source).toBeUndefined();
  }
  const run = await capture([
    "get",
    "1.1.1",
    "--root",
    w.atlas.root,
    "--resolve-anchors",
    "--json",
  ]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
});

test("a sibling directory that is not a git repository is unresolved, not read from disk", async () => {
  const w = world("not-git");
  const results = await resolveAll(w);
  for (const evidence of crossEvidence) {
    const r = result(results, evidence);
    expectUnresolved(r, /git/iu);
    expect(r.source).toBeUndefined();
  }
});

test("a sibling whose origin names another repository, or has no origin, is unresolved", async () => {
  for (const kind of ["wrong-origin", "no-origin"] as const) {
    const w = world(kind);
    const results = await resolveAll(w);
    for (const evidence of crossEvidence) {
      const r = result(results, evidence);
      expectUnresolved(r, /origin/iu);
      expect(r.source).toBeUndefined();
    }
  }
});

test("an anchor naming the Atlas's own repository resolves in-repo without a sibling", async () => {
  const w = world("missing");
  const results = await resolveAll(w);
  const link = `https://github.com/${atlasRepository}/blob/${w.atlasHead}/src/local.ts#L1`;
  for (const evidence of ["Own repository by name", "Local plain"]) {
    const r = result(results, evidence);
    expect({ status: r.status, revision: r.revision, line: r.line, link: r.link }).toEqual({
      status: "resolved",
      revision: w.atlasHead,
      line: 1,
      link,
    });
    expect(r.source ?? "HEAD").not.toMatch(/^origin\//u);
  }
});

test("cross-repository resolution and daq output are deterministic", async () => {
  const w = world();
  const a = await resolveAll(w);
  const b = await resolveAll(w);
  expect(b).toEqual(a);
  expect(result(a, "Cross enum variant")).toMatchObject({
    status: "resolved",
    source: "origin/trunk",
  });
  const argv = ["get", "1.1.1", "--root", w.atlas.root, "--resolve-anchors", "--json"];
  const first = await capture(argv);
  const second = await capture(argv);
  expect(first.code).toBe(0);
  expect(second.out).toBe(first.out);
});

test("daq get --resolve-anchors --json shows each cross-repository resolution with its source", async () => {
  const w = world();
  const results = await resolveAll(w);
  const run = await capture([
    "get",
    "1.1.1",
    "--root",
    w.atlas.root,
    "--resolve-anchors",
    "--json",
  ]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  const entry = (
    JSON.parse(run.out) as {
      entries: {
        evidence: { text: string; anchors?: { resolution?: Record<string, unknown> }[] }[];
      }[];
    }
  ).entries[0]!;
  const actual = entry.evidence.flatMap((evidence) =>
    (evidence.anchors ?? []).map((anchor) => ({ evidence: evidence.text, ...anchor.resolution })),
  );
  const expected = results.map(({ decisionId: _id, anchor: _anchor, evidence, ...resolution }) => ({
    evidence,
    ...resolution,
  }));
  expect(actual).toEqual(expected);
  const shown = actual.find((r) => r.evidence === "Cross enum variant")!;
  expect(shown).toMatchObject({
    status: "resolved",
    source: "origin/trunk",
    revision: w.c2,
    link: otherLink(w.c2, engine, lineOf(engineC2, "QueueOvenRecipe")),
  });
});
