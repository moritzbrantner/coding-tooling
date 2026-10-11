import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daqCommand } from "../src/daq-cli.ts";
import { buildAtlasIndex } from "../src/decision-atlas.ts";
import { queryDecisionAtlas } from "../src/daq.ts";

const repository = "moritzbrantner/daq-fixture";
const revision = "a".repeat(40);
const content =
  [
    "- **1** Game",
    "  - **1.1** Combat",
    "    - **1.1.1** [decision] **A** — Block with a shield. Tags: \x60block\x60, \x60combat\x60. Legacy alias: \x60game/combat/blocking\x60.",
    "    - **1.1.2** [decision] ~~Block automatically.~~ Block on input.",
    "    - **1.1.3** [decision] ~~Old parry mode.~~",
    "    - **1.1.4** [question] Should attacks be parried?",
    "    - **1.1.5** [decision] Yes, parry deliberately. Answers 1.1.4.",
    "  - **1.2** Travel",
    "    - **1.2.1** [question] Should mounts be allowed?",
    "    - **1.2.2** [decision] Allow fast travel.",
  ].join("\n") + "\n";

function index(text = content) {
  return buildAtlasIndex(repository, revision, [
    { path: "docs/decisions/atlas.md", format: "numbered-list", text },
  ]);
}

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "daq-"));
  directories.push(dir);
  return dir;
}

function capture(argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = daqCommand(argv, {
    write: (message) => {
      out += message;
    },
    error: (message) => {
      err += message;
    },
  });
  return { code, out, err };
}

test("get resolves stable IDs, project-scoped IDs, aliases, and retired entries", () => {
  const data = index();
  expect(queryDecisionAtlas(data, { action: "get", value: "1.1.1" }).entries[0]?.text).toContain(
    "Block with a shield",
  );
  expect(queryDecisionAtlas(data, { action: "get", value: "daq-fixture:1.1.1" }).shown).toBe(1);
  expect(
    queryDecisionAtlas(data, { action: "get", value: "game/combat/blocking" }).entries[0]?.id,
  ).toBe("1.1.1");
  const retired = queryDecisionAtlas(data, { action: "get", value: "1.1.3" }).entries[0];
  expect(retired?.status).toBe("superseded");
  expect(retired?.text).toBe("");
  expect(retired?.source.url).toContain("/blob/" + revision + "/docs/decisions/atlas.md#L");
  expect(() => queryDecisionAtlas(data, { action: "get", value: "foreign:1.1.1" })).toThrow(
    "another repository",
  );
  expect(() => queryDecisionAtlas(data, { action: "get", value: "999" })).toThrow("unknown ID");
});

test("find uses deterministic AND terms, relevance and only current wording", () => {
  const data = index();
  const results = queryDecisionAtlas(data, { action: "find", value: "combat block" });
  expect(results.entries.map((entry) => entry.id)).toEqual(["1.1.1", "1.1.2"]);
  expect(results.entries[0]?.text).not.toContain("Legacy alias:");
  expect(results.entries[1]?.text).toBe("Block on input.");
  expect(queryDecisionAtlas(data, { action: "find", value: "automatically" }).shown).toBe(0);
  expect(queryDecisionAtlas(data, { action: "find", value: "combat BLOCK", limit: 1 }).total).toBe(
    2,
  );
  expect(queryDecisionAtlas(data, { action: "find", value: "combat BLOCK", limit: 1 }).shown).toBe(
    1,
  );
  expect(() => queryDecisionAtlas(data, { action: "find", value: "" })).toThrow("search terms");
});

test("topic, kind, unanswered questions, and inactive controls are explicit", () => {
  const data = index();
  expect(queryDecisionAtlas(data, { action: "questions" }).entries.map((e) => e.id)).toEqual([
    "1.2.1",
  ]);
  expect(
    queryDecisionAtlas(data, { action: "questions", includeInactive: true }).entries.map(
      (entry) => entry.id,
    ),
  ).toEqual(["1.1.4", "1.2.1"]);
  expect(
    queryDecisionAtlas(data, { action: "list", topic: "1.1" }).entries.map((entry) => entry.id),
  ).toEqual(["1.1.1", "1.1.2", "1.1.5"]);
  expect(
    queryDecisionAtlas(data, {
      action: "list",
      topic: "COMBAT",
      includeInactive: true,
    }).entries.map((entry) => entry.id),
  ).toEqual(["1.1.1", "1.1.2", "1.1.3", "1.1.4", "1.1.5"]);
  expect(queryDecisionAtlas(data, { action: "list", kind: "question" }).shown).toBe(1);
  expect(() => queryDecisionAtlas(data, { action: "list", limit: 101 })).toThrow("limit");
});

test("indexed JSON is compact, deterministic, and never returns the entire Atlas", () => {
  const dir = tempDir();
  const source = join(dir, "index.json");
  writeFileSync(source, JSON.stringify(index()), "utf8");
  const first = capture(["find", "combat block", "--index", source, "--limit", "1", "--json"]);
  expect(first.code).toBe(0);
  expect(first.err).toBe("");
  const response = JSON.parse(first.out);
  expect(response.total).toBe(2);
  expect(response.shown).toBe(1);
  expect(response.entries[0].source.line).toBeGreaterThan(0);
  expect(response.entries[0].source.url).toContain(repository);
  expect(first.out).not.toContain("Should mounts be allowed?");
  expect(capture(["find", "combat block", "--index", source, "--limit", "1", "--json"])).toEqual(
    first,
  );
  expect(capture(["get", "foreign:1.1.1", "--index", source]).code).toBe(1);
  expect(capture(["get", "1.1.1", "--index", source, "--limit", "1000"]).code).toBe(1);
  const help = capture(["--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("daq find");
});

test("local queries use the committed owner source and reject dirty edits", () => {
  const root = tempDir();
  const location = join(root, "docs", "decisions");
  mkdirSync(location, { recursive: true });
  const path = join(location, "atlas.md");
  writeFileSync(path, content, "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "daq test");
  git("config", "user.email", "daq@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  git("add", ".");
  git("commit", "-qm", "atlas fixture");

  const result = capture(["questions", "--root", root, "--json"]);
  expect(result.code).toBe(0);
  const data = JSON.parse(result.out);
  expect(data.entries.map((entry: { id: string }) => entry.id)).toEqual(["1.2.1"]);
  expect(data.revision).toBe(git("rev-parse", "HEAD"));

  writeFileSync(path, content.replace("Allow fast travel.", "No fast travel."), "utf8");
  const stale = capture(["find", "travel", "--root", root]);
  expect(stale.code).toBe(1);
  expect(stale.err).toContain("uncommitted or stale");
});
