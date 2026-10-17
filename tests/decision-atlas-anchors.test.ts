/**
 * Independent acceptance for moritzbrantner/coding-tooling#323:
 * Decision Atlas evidence anchors that resolve source symbols and acceptance
 * tests, following owner decisions 4.3.1-4.3.5 (issue comment of 2026-10-17).
 *
 * Pinned seam (the issue leaves exact names open; these are the contract):
 *
 * Authoring (4.3.1): anchors are inline trailing tokens on an evidence checkbox
 * line. The anchor tail starts at the first " — " (space, U+2014, space) that is
 * immediately followed by a known kind token (`src:`, `test:` or `proof:`).
 * The tail is a "; "-separated list of `<kind>: <value>` segments:
 *     - [x] Queue oven recipe — src: crates/farm/src/engine.rs::FarmCommand::QueueOvenRecipe; test: crates/farm/tests/oven.rs::queues_recipe; proof: https://github.com/<o>/<r>/blob/<40-hex>/docs/proof.md
 *   - `src:` / `test:` value is `<repository-relative path>::<symbol>[@<40-hex>]`,
 *     split at the FIRST `::`. A trailing `@<40-hex sha>` pins the revision.
 *   - Rust symbols are `::`-separated item paths relative to the file: inline
 *     `mod` blocks add a segment, enum variants are `Enum::Variant`, methods in
 *     `impl Type` / `impl Trait for Type` are `Type::method`. Struct fields and
 *     `use` re-exports are not declarations.
 *   - TypeScript symbols are `.`-separated: `fn`, `Class`, `Class.method`
 *     (static or instance), `Namespace.member`, top-level `const`.
 *   - Test cases: Rust `test:` names a `#[test]` fn by item path (a plain helper
 *     fn is not a test). TypeScript `test:` names a `test(...)` / `it(...)` call
 *     by its literal name; enclosing `describe("X", ...)` blocks are joined with
 *     " > " (e.g. `Oven > bakes bread`); the bare inner name does not match.
 *   - `proof:` value must be an immutable GitHub blob URL
 *     `https://github.com/<o>/<r>/blob/<40-hex>/<path>`; it is kept verbatim with
 *     `revision` = that sha. A mutable URL (branch name, `tree/`, non-URL) fails.
 *   - A cross-repository anchor is written `<owner>/<repo>:<path>::<symbol>`;
 *     it is parsed (indexing does not fail) and reported `unresolved`.
 *
 * Index (`buildAtlasIndex`, `indexRepository`; JSON output contract):
 *   - Evidence items keep `{ text, checked }`; `text` EXCLUDES the anchor tail.
 *     An item with anchors gains
 *       anchors: { kind: "src" | "test" | "proof"; path?: string; symbol?: string;
 *                  revision?: string; url?: string }[]
 *     in authored order (`symbol` excludes `@sha`; `revision` only when pinned or
 *     for proof). Anchors never contain a line number (identity is path+symbol).
 *     Items without anchors are unchanged (`anchors` absent or `[]`).
 *   - `validateAtlasIndex` accepts anchors, rejects an unknown anchor kind; the
 *     decision JSON schema documents `anchors`; `daq --index` keeps them.
 *
 * Malformed anchors fail closed (thrown `Decision Atlas: <path>:<line> ...`,
 * message mentions "anchor"): `src:` without `::symbol`, empty path or symbol,
 * `test:` without a case, unknown kind in a tail (e.g. `tst:`), short/invalid
 * `@sha`, absolute or `..` path, mutable or non-URL `proof:`.
 *
 * Resolution (4.3.2-4.3.4): module `src/decision-atlas-anchors.ts` exports
 *     resolveAtlasAnchors(root: string, index: AtlasIndex)
 *       : AnchorResolution[] | Promise<AnchorResolution[]>
 *     AnchorResolution = { decisionId: string; evidence: string /* item text *\/;
 *       anchor: <the index anchor object>; status: "resolved" | "stale" |
 *       "ambiguous" | "unresolved"; reason?: string; revision?: string;
 *       line?: number; link?: string }
 *   one result per anchor, in index decision order, then evidence order, then
 *   anchor order. Files are read from git objects at the checkout's committed
 *   HEAD (or the pinned sha), never from the working tree.
 *   - resolved: supported language, file present at the revision, exactly one
 *     matching declaration. `revision` = checked 40-hex commit, `line` = 1-based
 *     line of the symbol's name identifier (TS test: line of the test/it call),
 *     `link` = https://github.com/<repository>/blob/<revision>/<path>#L<line>.
 *     Line and link are derived display output only.
 *   - stale: file missing at the revision, or present but no matching
 *     declaration (renamed, moved to another file, removed, only mentioned in a
 *     comment/string, or only a longer/shorter identifier exists).
 *   - ambiguous: two or more matching declarations (e.g. cfg twins, duplicate
 *     test names).
 *   - unresolved: cannot be checked here: unsupported language (e.g. `.py`),
 *     cross-repository anchor, pinned 40-hex sha unknown to the repository, and
 *     every `proof:` anchor (URLs are never fetched; proof is not verification).
 *   Non-resolved results carry a non-empty `reason`, and no `line`/`link`.
 *
 * Report-only (4.3.5): resolution never mutates the index, never changes
 * `checked`, progress, `implementation.verification` ("unverified") or
 * `provenance.implementation` ("not-verified"), and nothing claims "verified".
 *
 * CLI: `daq get <id> --root <checkout> --resolve-anchors [--json]`. In JSON each
 * `entries[].evidence[].anchors[]` gains `resolution: { status, reason?,
 * revision?, line?, link? }` equal to the function's result; the text output
 * prints each anchor's status word and, when resolved, its link, alongside the
 * unchanged `completed/total` progress line. `daqCommand` may become async.
 *
 * Out of scope (stated gaps): cross-repository resolution, running tests,
 * fetching proof URLs, out-of-line `mod x;` files and macro-generated items.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { daqCommand } from "../src/daq-cli.ts";
import { indexRepository } from "../src/decision-atlas-cli.ts";
import {
  buildAtlasIndex,
  evidenceProgress,
  validateAtlasIndex,
  type AtlasIndex,
} from "../src/decision-atlas.ts";

const repository = "moritzbrantner/anchor-fixture";
const fakeRevision = "a".repeat(40);
const sourcePath = "docs/decisions/atlas.md";
const proofSha = "d".repeat(40);
const proofUrl = `https://github.com/${repository}/blob/${proofSha}/docs/proof.md`;

interface Anchor {
  kind: "src" | "test" | "proof";
  path?: string;
  symbol?: string;
  revision?: string;
  url?: string;
  /** Present only in `daq get --resolve-anchors --json` output. */
  resolution?: {
    status?: Status;
    reason?: string;
    revision?: string;
    line?: number;
    link?: string;
  };
}
interface Evidence {
  text: string;
  checked: boolean;
  anchors?: Anchor[];
}
type Status = "resolved" | "stale" | "ambiguous" | "unresolved";
interface Resolution {
  decisionId: string;
  evidence: string;
  anchor: Anchor;
  status: Status;
  reason?: string;
  revision?: string;
  line?: number;
  link?: string;
}

// ---------------------------------------------------------------- fixtures

const engineRs = `//! Farm engine. Docs mention FarmCommand::Ghost, which does not exist.
// Oven::label and Slot::reserve are mentioned in this comment only.

/// A farm command; see Ghost.
pub enum FarmCommand {
    QueueOvenRecipe { recipe: String },
    QueueOvenRecipeV2(u32),
    Harvest,
}

impl FarmCommand {
    pub fn label(&self) -> &'static str {
        let _ghost = "FarmCommand::Ghost";
        "command"
    }
}

pub struct Oven {
    pub temperature: u32,
}

pub fn queue_oven_recipe(recipe: &str) -> FarmCommand {
    FarmCommand::QueueOvenRecipe { recipe: recipe.to_string() }
}

pub mod scheduling {
    pub struct Slot;

    impl Slot {
        pub fn reserve(&self) {}
    }
}

#[cfg(feature = "fast")]
pub fn tick() {}

#[cfg(not(feature = "fast"))]
pub fn tick() {}
`;

const legacyRs = `// QueueOvenRecipe was renamed; "QueueOvenRecipe" survives only in text.
pub enum FarmCommand {
    QueueOvenRecipeV2,
}

pub const OLD_NAME: &str = "QueueOvenRecipe";
`;

const ovenTestsRs = `// fn rejects_empty() {} is commented out.
fn helper_setup() -> u32 {
    7
}

#[test]
fn queues_recipe() {
    assert_eq!(helper_setup(), 7);
    let _name = "rejects_empty";
}

#[cfg(test)]
mod nested {
    #[test]
    fn bakes_bread() {}
}
`;

const ovenTs = `// GhostRecipe and bake are mentioned in this comment only; queueRecipe too.
const note = "GhostRecipe Oven.queueRecipe";

export const MAX_QUEUE = 4;

export function queueRecipe(name: string): string {
  return note + name;
}

export function queueRecipeV2(): void {}

export class Oven {
  bake(): void {}

  static create(): Oven {
    return new Oven();
  }
}

export namespace Recipes {
  export const DEFAULT = "bread";
}
`;

const ovenTestTs = `import { describe, expect, it, test } from "bun:test";

// test("commented out", () => {});
const label = "queues a recipe";

test("queues a recipe", () => {
  expect(label).toBe("queues a recipe");
});

describe("Oven", () => {
  it("bakes bread", () => {});
});

test("duplicated", () => {});
test("duplicated", () => {});
`;

const buildPy = `def main():
    pass
`;

const codeFiles: Record<string, string> = {
  "crates/farm/src/engine.rs": engineRs,
  "crates/farm/src/legacy.rs": legacyRs,
  "crates/farm/tests/oven.rs": ovenTestsRs,
  "src/oven.ts": ovenTs,
  "tests/oven.test.ts": ovenTestTs,
  "tools/build.py": buildPy,
};

const engine = "crates/farm/src/engine.rs";
const ovenTests = "crates/farm/tests/oven.rs";

const atlas = `# Anchor fixture

## Entries

- **1** Farm
  - **1.1** Oven
    - **1.1.1** [decision] The oven queues recipes.
      - [x] Queue oven recipe — src: ${engine}::FarmCommand::QueueOvenRecipe; test: ${ovenTests}::queues_recipe; proof: ${proofUrl}
      - [ ] Commands have labels — src: ${engine}::FarmCommand::label
      - [ ] Oven state is a struct — src: ${engine}::Oven
      - [ ] Free function queues — src: ${engine}::queue_oven_recipe
      - [ ] Slots reserve in the scheduling module — src: ${engine}::scheduling::Slot::reserve
      - [x] Nested Rust test — test: ${ovenTests}::nested::bakes_bread
      - [ ] Plain evidence without anchors.
      - [ ] Cart — persists across reloads.
    - **1.1.2** [decision] The TypeScript client mirrors the oven.
      - [ ] Client queues — src: src/oven.ts::queueRecipe; test: tests/oven.test.ts::queues a recipe
      - [ ] Client oven bakes — src: src/oven.ts::Oven.bake; test: tests/oven.test.ts::Oven > bakes bread
      - [ ] Client oven factory — src: src/oven.ts::Oven.create
      - [ ] Client recipe defaults — src: src/oven.ts::Recipes.DEFAULT
      - [ ] Client queue limit — src: src/oven.ts::MAX_QUEUE
  - **1.2** Traps
    - **1.2.1** [decision] Traps never resolve.
      - [ ] Comment-only Rust symbol — src: ${engine}::FarmCommand::Ghost
      - [ ] Rust prefix substring — src: ${engine}::FarmCommand::QueueOven
      - [ ] Rust longer identifier only — src: crates/farm/src/legacy.rs::FarmCommand::QueueOvenRecipe
      - [ ] Rust wrong owner — src: ${engine}::Oven::label
      - [ ] Rust missing module prefix — src: ${engine}::Slot::reserve
      - [ ] Rust helper is not a test — test: ${ovenTests}::helper_setup
      - [ ] Rust commented-out test — test: ${ovenTests}::rejects_empty
      - [ ] TS comment and string only — src: src/oven.ts::GhostRecipe
      - [ ] TS prefix substring — src: src/oven.ts::queueRecip
      - [ ] TS wrong owner — src: src/oven.ts::Oven.queueRecipe
      - [ ] TS method is not top level — src: src/oven.ts::bake
      - [ ] TS test without describe path — test: tests/oven.test.ts::bakes bread
      - [ ] TS commented-out test — test: tests/oven.test.ts::commented out
      - [ ] TS test name prefix — test: tests/oven.test.ts::queues a
      - [ ] Missing file — src: crates/farm/src/absent.rs::Absent
    - **1.2.2** [decision] Ambiguity and unsupported anchors are reported.
      - [ ] Rust cfg twins — src: ${engine}::tick
      - [ ] TS duplicate test — test: tests/oven.test.ts::duplicated
      - [ ] Python is unsupported — src: tools/build.py::main
      - [ ] Another repository — src: moritzbrantner/my-farm:${engine}::FarmCommand
    - **1.2.3** [decision] Unaudited Decision stays unaudited.
`;

/** The same Atlas with every anchor tail removed. */
function stripAnchors(text: string): string {
  return text.replace(/ — (?:src|test|proof): .*$/gmu, "");
}

// ---------------------------------------------------------------- helpers

function build(text: string): AtlasIndex {
  return buildAtlasIndex(repository, fakeRevision, [
    { path: sourcePath, format: "numbered-list", text },
  ]);
}

function evidenceOf(index: AtlasIndex, id: string): Evidence[] {
  const found = index.decisions.find((decision) => decision.id === id);
  if (!found) throw new Error("missing " + id);
  return ((found as { evidence?: Evidence[] }).evidence ?? []) as Evidence[];
}

function item(index: AtlasIndex, id: string, text: string): Evidence {
  const found = evidenceOf(index, id).find((evidence) => evidence.text === text);
  if (!found)
    throw new Error(
      `missing evidence ${text} under ${id}: ` + JSON.stringify(evidenceOf(index, id)),
    );
  return found;
}

function lineOf(text: string, needle: string): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  throw new Error("missing line " + needle);
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a diagnostic, but the Atlas was accepted");
}

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Checkout {
  root: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (message: string) => string;
}

function checkout(files: Record<string, string>): Checkout {
  const root = mkdtempSync(join(tmpdir(), "atlas-anchors-"));
  directories.push(root);
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
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Atlas anchor acceptance");
  git("config", "user.email", "atlas@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit("fixture");
  return { root, git, write, commit };
}

function indexAt(repo: Checkout): AtlasIndex {
  return indexRepository({
    root: repo.root,
    repository,
    source: sourcePath,
    format: "numbered-list",
    revision: repo.git("rev-parse", "HEAD"),
  });
}

// Loaded by a computed specifier so the baseline (no module yet) fails per test
// instead of failing type checking or the whole file.
const anchorsModule = "../src/decision-atlas-anchors.ts";
async function resolve(root: string, index: AtlasIndex): Promise<Resolution[]> {
  const mod = (await import(anchorsModule)) as {
    resolveAtlasAnchors: (root: string, index: AtlasIndex) => Resolution[] | Promise<Resolution[]>;
  };
  expect(typeof mod.resolveAtlasAnchors).toBe("function");
  return await mod.resolveAtlasAnchors(root, index);
}

function result(results: Resolution[], evidence: string, kind: Anchor["kind"]): Resolution {
  const matches = results.filter((r) => r.evidence === evidence && r.anchor.kind === kind);
  if (matches.length !== 1)
    throw new Error(`expected one ${kind} result for ${evidence}, got ${matches.length}`);
  return matches[0]!;
}

function blob(revision: string, path: string, line: number): string {
  return `https://github.com/${repository}/blob/${revision}/${path}#L${line}`;
}

function expectResolved(r: Resolution, revision: string, path: string, line: number): void {
  expect({ status: r.status, revision: r.revision, line: r.line, link: r.link }).toEqual({
    status: "resolved",
    revision,
    line,
    link: blob(revision, path, line),
  });
}

function expectNotResolved(r: Resolution, status: Exclude<Status, "resolved">): void {
  expect({ evidence: r.evidence, status: r.status }).toEqual({ evidence: r.evidence, status });
  expect(typeof r.reason).toBe("string");
  expect(r.reason!.trim().length).toBeGreaterThan(0);
  expect(r.line).toBeUndefined();
  expect(r.link).toBeUndefined();
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

function fixtureRepo(): Checkout {
  return checkout({ ...codeFiles, [sourcePath]: atlas });
}

// ---------------------------------------------------------------- parsing

test("anchor tail is parsed into ordered anchors and excluded from the evidence text", () => {
  const index = build(atlas);
  const first = item(index, "1.1.1", "Queue oven recipe");
  expect(first.checked).toBe(true);
  expect(first.anchors).toEqual([
    { kind: "src", path: engine, symbol: "FarmCommand::QueueOvenRecipe" },
    { kind: "test", path: ovenTests, symbol: "queues_recipe" },
    { kind: "proof", url: proofUrl, revision: proofSha },
  ]);
  expect(item(index, "1.1.2", "Client oven bakes").anchors).toEqual([
    { kind: "src", path: "src/oven.ts", symbol: "Oven.bake" },
    { kind: "test", path: "tests/oven.test.ts", symbol: "Oven > bakes bread" },
  ]);
  expect(item(index, "1.1.1", "Slots reserve in the scheduling module").anchors).toEqual([
    { kind: "src", path: engine, symbol: "scheduling::Slot::reserve" },
  ]);
  // No item text keeps an anchor tail; line numbers are never part of anchor identity.
  for (const decision of index.decisions)
    for (const evidence of evidenceOf(index, decision.id)) {
      expect(evidence.text).not.toMatch(/ — (?:src|test|proof):/u);
      for (const anchor of evidence.anchors ?? []) {
        expect(
          Object.keys(anchor).every((key) =>
            ["kind", "path", "symbol", "revision", "url"].includes(key),
          ),
        ).toBe(true);
      }
    }
});

test("evidence without anchors keeps the previous shape, including prose with an em dash", () => {
  const index = build(atlas);
  for (const text of ["Plain evidence without anchors.", "Cart — persists across reloads."]) {
    const evidence = item(index, "1.1.1", text);
    expect(evidence.anchors ?? []).toEqual([]);
    expect({ text: evidence.text, checked: evidence.checked }).toEqual({ text, checked: false });
  }
  // An Atlas with no anchors at all indexes exactly as before (#322 shape).
  const plain = build(stripAnchors(atlas));
  for (const decision of plain.decisions)
    for (const evidence of evidenceOf(plain, decision.id)) {
      expect(evidence.anchors ?? []).toEqual([]);
      const { anchors: _ignored, ...rest } = evidence;
      expect(new Set(Object.keys(rest))).toEqual(new Set(["checked", "text"]));
    }
});

test("a pinned @sha is split from the symbol and a proof keeps its immutable revision", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const index = build(
    atlas.replace(
      "      - [ ] Plain evidence without anchors.",
      `      - [ ] Pinned anchor — src: ${engine}::FarmCommand::Harvest@${sha}; test: ${ovenTests}::queues_recipe@${sha}`,
    ),
  );
  expect(item(index, "1.1.1", "Pinned anchor").anchors).toEqual([
    { kind: "src", path: engine, symbol: "FarmCommand::Harvest", revision: sha },
    { kind: "test", path: ovenTests, symbol: "queues_recipe", revision: sha },
  ]);
  const proof = item(index, "1.1.1", "Queue oven recipe").anchors!.find((a) => a.kind === "proof");
  expect(proof).toEqual({ kind: "proof", url: proofUrl, revision: proofSha });
});

test("malformed anchor tokens fail closed with <path>:<line>", () => {
  const malformed = [
    `src: ${engine}`,
    `src: ::FarmCommand`,
    `src: ${engine}::`,
    `test: ${ovenTests}`,
    `src: ${engine}::Oven; tst: ${ovenTests}::queues_recipe`,
    `src: ${engine}::Oven@abc123`,
    `src: ${engine}::Oven@${"z".repeat(40)}`,
    `src: /abs/engine.rs::Oven`,
    `src: ../outside/engine.rs::Oven`,
    `proof: https://github.com/${repository}/blob/main/docs/proof.md`,
    `proof: https://github.com/${repository}/tree/${proofSha}/docs`,
    `proof: not-a-url`,
  ];
  const anchorLine = "      - [ ] Broken anchor — ";
  const at = lineOf(atlas, "Plain evidence without anchors.");
  for (const tail of malformed) {
    const text = atlas.replace("      - [ ] Plain evidence without anchors.", anchorLine + tail);
    const message = thrown(() => build(text));
    expect({ tail, message }).toEqual({
      tail,
      message: expect.stringContaining(`${sourcePath}:${at}`),
    });
    expect({ tail, message }).toEqual({ tail, message: expect.stringMatching(/anchor/iu) });
  }
});

test("anchors survive index validation and daq --index; an unknown anchor kind is rejected", async () => {
  const index = build(atlas);
  expect(() => validateAtlasIndex(JSON.parse(JSON.stringify(index)) as AtlasIndex)).not.toThrow();

  const dir = mkdtempSync(join(tmpdir(), "atlas-anchors-index-"));
  directories.push(dir);
  const file = join(dir, "index.json");
  writeFileSync(file, JSON.stringify(index), "utf8");
  const shown = await capture(["get", "1.1.1", "--index", file, "--json"]);
  expect(shown.err).toBe("");
  expect(shown.code).toBe(0);
  const entry = (JSON.parse(shown.out) as { entries: { evidence: Evidence[] }[] }).entries[0]!;
  const queued = entry.evidence.find((evidence) => evidence.text === "Queue oven recipe")!;
  expect(queued.anchors?.map((anchor) => anchor.kind)).toEqual(["src", "test", "proof"]);
  expect(queued.anchors?.[0]).toEqual({
    kind: "src",
    path: engine,
    symbol: "FarmCommand::QueueOvenRecipe",
  });

  const tampered = JSON.parse(JSON.stringify(index)) as AtlasIndex;
  const decision = tampered.decisions.find((d) => d.id === "1.1.1") as unknown as {
    evidence: Evidence[];
  };
  (decision.evidence[0]!.anchors![0] as { kind: string }).kind = "spec";
  expect(() => validateAtlasIndex(tampered)).toThrow();
});

test("the decision JSON schema documents evidence anchors", () => {
  const schema = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "schemas", "decision-atlas-decision.schema.json"),
      "utf8",
    ),
  ) as { properties: { evidence: { items: { properties: Record<string, unknown> } } } };
  const anchors = schema.properties.evidence.items.properties.anchors as
    | { type?: string; items?: { properties?: Record<string, unknown> } }
    | undefined;
  expect(anchors?.type).toBe("array");
  expect(Object.keys(anchors?.items?.properties ?? {})).toEqual(
    expect.arrayContaining(["kind", "path", "symbol", "revision", "url"]),
  );
});

test("anchors are report-only: boxes, progress and verification state are unchanged", () => {
  const anchored = build(atlas);
  const plain = build(stripAnchors(atlas));
  for (const decision of anchored.decisions) {
    expect(
      evidenceOf(anchored, decision.id).map(({ text, checked }) => ({ text, checked })),
    ).toEqual(evidenceOf(plain, decision.id).map(({ text, checked }) => ({ text, checked })));
    expect(evidenceProgress(decision)).toEqual(
      evidenceProgress(plain.decisions.find((d) => d.id === decision.id)!),
    );
    expect(decision.implementation.verification).toBe("unverified");
  }
  expect(evidenceProgress(anchored.decisions.find((d) => d.id === "1.1.1")!)).toEqual({
    status: "audited",
    completed: 2,
    total: 8,
    percent: 25,
  });
  expect(anchored.provenance.implementation).toBe("not-verified");
});

// ---------------------------------------------------------------- resolution

test("Rust enum variant, impl method, struct, fn and nested module item resolve with derived lines", async () => {
  const repo = fixtureRepo();
  const head = repo.git("rev-parse", "HEAD");
  const results = await resolve(repo.root, indexAt(repo));
  expectResolved(
    result(results, "Queue oven recipe", "src"),
    head,
    engine,
    lineOf(engineRs, "    QueueOvenRecipe {"),
  );
  expectResolved(
    result(results, "Commands have labels", "src"),
    head,
    engine,
    lineOf(engineRs, "pub fn label("),
  );
  expectResolved(
    result(results, "Oven state is a struct", "src"),
    head,
    engine,
    lineOf(engineRs, "pub struct Oven"),
  );
  expectResolved(
    result(results, "Free function queues", "src"),
    head,
    engine,
    lineOf(engineRs, "pub fn queue_oven_recipe"),
  );
  expectResolved(
    result(results, "Slots reserve in the scheduling module", "src"),
    head,
    engine,
    lineOf(engineRs, "pub fn reserve"),
  );
});

test("TypeScript function, class method, static method, namespace member and const resolve", async () => {
  const repo = fixtureRepo();
  const head = repo.git("rev-parse", "HEAD");
  const results = await resolve(repo.root, indexAt(repo));
  const ts = "src/oven.ts";
  expectResolved(
    result(results, "Client queues", "src"),
    head,
    ts,
    lineOf(ovenTs, "export function queueRecipe("),
  );
  expectResolved(
    result(results, "Client oven bakes", "src"),
    head,
    ts,
    lineOf(ovenTs, "  bake(): void"),
  );
  expectResolved(
    result(results, "Client oven factory", "src"),
    head,
    ts,
    lineOf(ovenTs, "static create("),
  );
  expectResolved(
    result(results, "Client recipe defaults", "src"),
    head,
    ts,
    lineOf(ovenTs, "export const DEFAULT"),
  );
  expectResolved(
    result(results, "Client queue limit", "src"),
    head,
    ts,
    lineOf(ovenTs, "export const MAX_QUEUE"),
  );
});

test("Rust #[test] fns and TypeScript test()/it() cases resolve as test anchors", async () => {
  const repo = fixtureRepo();
  const head = repo.git("rev-parse", "HEAD");
  const results = await resolve(repo.root, indexAt(repo));
  expectResolved(
    result(results, "Queue oven recipe", "test"),
    head,
    ovenTests,
    lineOf(ovenTestsRs, "fn queues_recipe"),
  );
  expectResolved(
    result(results, "Nested Rust test", "test"),
    head,
    ovenTests,
    lineOf(ovenTestsRs, "fn bakes_bread"),
  );
  expectResolved(
    result(results, "Client queues", "test"),
    head,
    "tests/oven.test.ts",
    lineOf(ovenTestTs, 'test("queues a recipe"'),
  );
  expectResolved(
    result(results, "Client oven bakes", "test"),
    head,
    "tests/oven.test.ts",
    lineOf(ovenTestTs, 'it("bakes bread"'),
  );
});

test("substring traps, wrong owners, non-test helpers and missing files are stale, never resolved", async () => {
  const repo = fixtureRepo();
  const head = repo.git("rev-parse", "HEAD");
  const results = await resolve(repo.root, indexAt(repo));
  const traps: [string, Anchor["kind"]][] = [
    ["Comment-only Rust symbol", "src"],
    ["Rust prefix substring", "src"],
    ["Rust longer identifier only", "src"],
    ["Rust wrong owner", "src"],
    ["Rust missing module prefix", "src"],
    ["Rust helper is not a test", "test"],
    ["Rust commented-out test", "test"],
    ["TS comment and string only", "src"],
    ["TS prefix substring", "src"],
    ["TS wrong owner", "src"],
    ["TS method is not top level", "src"],
    ["TS test without describe path", "test"],
    ["TS commented-out test", "test"],
    ["TS test name prefix", "test"],
    ["Missing file", "src"],
  ];
  for (const [evidence, kind] of traps) {
    const r = result(results, evidence, kind);
    expectNotResolved(r, "stale");
    expect(r.revision).toBe(head);
  }
});

test("two matching declarations are ambiguous", async () => {
  const repo = fixtureRepo();
  const results = await resolve(repo.root, indexAt(repo));
  expectNotResolved(result(results, "Rust cfg twins", "src"), "ambiguous");
  expectNotResolved(result(results, "TS duplicate test", "test"), "ambiguous");
});

test("unsupported language, cross-repository and proof anchors are unresolved without breaking indexing", async () => {
  const repo = fixtureRepo();
  const index = indexAt(repo);
  const results = await resolve(repo.root, index);
  const python = result(results, "Python is unsupported", "src");
  expectNotResolved(python, "unresolved");
  expect(python.reason).toMatch(/language|unsupported/iu);
  const other = result(results, "Another repository", "src");
  expectNotResolved(other, "unresolved");
  expect(other.reason).toMatch(/repositor/iu);
  const proof = result(results, "Queue oven recipe", "proof");
  expectNotResolved(proof, "unresolved");
  expect(proof.anchor).toEqual({ kind: "proof", url: proofUrl, revision: proofSha });
  // No result status claims verification; only the four pinned statuses exist.
  for (const r of results)
    expect(["resolved", "stale", "ambiguous", "unresolved"]).toContain(r.status);
});

test("one result per anchor in decision, evidence and anchor order", async () => {
  const repo = fixtureRepo();
  const index = indexAt(repo);
  const results = await resolve(repo.root, index);
  const expected = index.decisions.flatMap((decision) =>
    evidenceOf(index, decision.id).flatMap((evidence) =>
      (evidence.anchors ?? []).map((anchor) => ({
        decisionId: decision.id,
        evidence: evidence.text,
        anchor,
      })),
    ),
  );
  expect(expected.length).toBe(34);
  expect(
    results.map(({ decisionId, evidence, anchor }) => ({ decisionId, evidence, anchor })),
  ).toEqual(expected);
});

test("line movement keeps an anchor resolved; rename or move to another file makes it stale", async () => {
  const simpleRs = "pub enum FarmCommand {\n    QueueOvenRecipe,\n}\n\npub fn run() {}\n";
  const simpleTs = "export class Oven {\n  bake(): void {}\n}\n";
  const simpleAtlas = `- **1** Farm
  - **1.1** Oven
    - **1.1.1** [decision] Recipes queue.
      - [ ] Variant exists — src: ${engine}::FarmCommand::QueueOvenRecipe
      - [ ] Method exists — src: src/oven.ts::Oven.bake
`;
  const repo = checkout({ [engine]: simpleRs, "src/oven.ts": simpleTs, [sourcePath]: simpleAtlas });
  const first = repo.git("rev-parse", "HEAD");
  const firstIndex = indexAt(repo);
  let results = await resolve(repo.root, firstIndex);
  expectResolved(result(results, "Variant exists", "src"), first, engine, 2);
  expectResolved(result(results, "Method exists", "src"), first, "src/oven.ts", 2);

  repo.write(engine, "// one\n// two\n// three\n" + simpleRs);
  repo.write("src/oven.ts", "\n\n" + simpleTs);
  const moved = repo.commit("move lines");
  const movedIndex = indexAt(repo);
  // Identity (the authored anchors) is unchanged; only derived display lines move.
  expect(evidenceOf(movedIndex, "1.1.1")).toEqual(evidenceOf(firstIndex, "1.1.1"));
  results = await resolve(repo.root, movedIndex);
  expectResolved(result(results, "Variant exists", "src"), moved, engine, 5);
  expectResolved(result(results, "Method exists", "src"), moved, "src/oven.ts", 4);

  repo.write(engine, simpleRs.replace("QueueOvenRecipe", "EnqueueOvenRecipe"));
  repo.write("src/oven.ts", simpleTs.replace("bake", "roast"));
  const renamed = repo.commit("rename");
  results = await resolve(repo.root, indexAt(repo));
  expectNotResolved(result(results, "Variant exists", "src"), "stale");
  expectNotResolved(result(results, "Method exists", "src"), "stale");
  expect(result(results, "Variant exists", "src").revision).toBe(renamed);

  repo.write(engine, "pub fn run() {}\n");
  repo.write("crates/farm/src/commands.rs", simpleRs);
  repo.write("src/oven.ts", "export const placeholder = 1;\n");
  repo.write("src/kitchen.ts", simpleTs);
  repo.commit("move to other files");
  results = await resolve(repo.root, indexAt(repo));
  expectNotResolved(result(results, "Variant exists", "src"), "stale");
  expectNotResolved(result(results, "Method exists", "src"), "stale");
});

test("a pinned @sha is checked at that revision; an unknown sha is unresolved", async () => {
  const withLegacy = "pub fn legacy_queue() {}\n\npub fn run() {}\n";
  const repo = checkout({ [engine]: withLegacy });
  const old = repo.git("rev-parse", "HEAD");
  repo.write(engine, "pub fn run() {}\n");
  repo.commit("remove legacy_queue");
  const unknown = "e".repeat(40);
  repo.write(
    sourcePath,
    `- **1** Farm
  - **1.1** Oven
    - **1.1.1** [decision] Legacy queue existed.
      - [x] Pinned legacy — src: ${engine}::legacy_queue@${old}
      - [x] Unpinned legacy — src: ${engine}::legacy_queue
      - [ ] Unknown pin — src: ${engine}::run@${unknown}
`,
  );
  const head = repo.commit("atlas");
  const index = indexAt(repo);
  const results = await resolve(repo.root, index);
  const pinned = result(results, "Pinned legacy", "src");
  expect(pinned.anchor).toEqual({
    kind: "src",
    path: engine,
    symbol: "legacy_queue",
    revision: old,
  });
  expectResolved(pinned, old, engine, 1);
  const unpinned = result(results, "Unpinned legacy", "src");
  expectNotResolved(unpinned, "stale");
  expect(unpinned.revision).toBe(head);
  const bogus = result(results, "Unknown pin", "src");
  expectNotResolved(bogus, "unresolved");
  expect(bogus.reason).toMatch(/revision|commit|sha/iu);
});

test("uncommitted working-tree edits never make an anchor resolve or go stale", async () => {
  const repo = checkout({
    [engine]: "pub fn run() {}\n",
    "src/oven.ts": "export const placeholder = 1;\n",
    [sourcePath]: `- **1** Farm
  - **1.1** Oven
    - **1.1.1** [decision] Work in progress.
      - [ ] Added only in the working tree — src: ${engine}::draft
      - [ ] Untracked file — src: crates/farm/src/draft.rs::Draft
      - [ ] Deleted only in the working tree — src: ${engine}::run
      - [ ] TS added only in the working tree — src: src/oven.ts::draft
`,
  });
  const head = repo.git("rev-parse", "HEAD");
  repo.write(engine, "pub fn draft() {}\n");
  repo.write("crates/farm/src/draft.rs", "pub struct Draft;\n");
  repo.write("src/oven.ts", "export function draft(): void {}\n");
  const index = indexAt(repo);
  const results = await resolve(repo.root, index);
  expectNotResolved(result(results, "Added only in the working tree", "src"), "stale");
  expectNotResolved(result(results, "Untracked file", "src"), "stale");
  expectNotResolved(result(results, "TS added only in the working tree", "src"), "stale");
  expectResolved(result(results, "Deleted only in the working tree", "src"), head, engine, 1);
});

test("resolution is report-only: it never mutates the index, boxes or progress", async () => {
  const repo = fixtureRepo();
  const index = indexAt(repo);
  const before = JSON.stringify(index);
  const results = await resolve(repo.root, index);
  expect(JSON.stringify(index)).toBe(before);
  // A resolved anchor on an unchecked box stays unchecked.
  expect(result(results, "Commands have labels", "src").status).toBe("resolved");
  expect(item(index, "1.1.1", "Commands have labels").checked).toBe(false);
  expect(evidenceProgress(index.decisions.find((d) => d.id === "1.1.2")!)).toEqual({
    status: "audited",
    completed: 0,
    total: 5,
    percent: 0,
  });
  for (const decision of index.decisions)
    expect(decision.implementation.verification).toBe("unverified");
  expect(index.provenance.implementation).toBe("not-verified");
});

test("daq get --resolve-anchors --json attaches each anchor's resolution", async () => {
  const repo = fixtureRepo();
  const results = await resolve(repo.root, indexAt(repo));
  for (const id of ["1.1.1", "1.1.2", "1.2.1", "1.2.2"]) {
    const run = await capture(["get", id, "--root", repo.root, "--resolve-anchors", "--json"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const entry = (
      JSON.parse(run.out) as {
        entries: {
          progress: unknown;
          evidence: Evidence[];
        }[];
      }
    ).entries[0]!;
    const expected = results
      .filter((r) => r.decisionId === id)
      .map((r) => ({
        evidence: r.evidence,
        kind: r.anchor.kind,
        status: r.status,
        line: r.line,
        link: r.link,
      }));
    const actual = entry.evidence.flatMap((evidence) =>
      (evidence.anchors ?? []).map((anchor) => ({
        evidence: evidence.text,
        kind: anchor.kind,
        status: anchor.resolution?.status,
        line: anchor.resolution?.line,
        link: anchor.resolution?.link,
      })),
    );
    expect(actual).toEqual(expected);
  }
});

test("daq get --resolve-anchors text shows status and links but keeps progress and claims no verification", async () => {
  const repo = fixtureRepo();
  const head = repo.git("rev-parse", "HEAD");
  const plain = await capture(["get", "1.1.1", "--root", repo.root]);
  expect(plain.code).toBe(0);
  const run = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("2/8");
  expect(plain.out).toContain("2/8");
  expect(run.out).toContain("resolved");
  expect(run.out).toContain(blob(head, engine, lineOf(engineRs, "    QueueOvenRecipe {")));
  expect(run.out).toMatch(/\[x\] Queue oven recipe/u);
  expect(run.out).toMatch(/\[ \] Commands have labels/u);
  expect(run.out).not.toMatch(/(?<!un|not |not-)verified/iu);

  const traps = await capture(["get", "1.2.1", "--root", repo.root, "--resolve-anchors"]);
  expect(traps.code).toBe(0);
  expect(traps.out).toContain("stale");
  expect(traps.out).toContain("0/15");
  expect(traps.out).not.toMatch(/(?<!un|not |not-)verified/iu);
});

test("resolution and CLI output are deterministic across repeated runs", async () => {
  const repo = fixtureRepo();
  const index = indexAt(repo);
  const first = await resolve(repo.root, index);
  const second = await resolve(repo.root, indexAt(repo));
  expect(second).toEqual(first);
  const a = await capture(["get", "1.2.1", "--root", repo.root, "--resolve-anchors", "--json"]);
  const b = await capture(["get", "1.2.1", "--root", repo.root, "--resolve-anchors", "--json"]);
  expect(a.code).toBe(0);
  expect(b.out).toBe(a.out);
});
