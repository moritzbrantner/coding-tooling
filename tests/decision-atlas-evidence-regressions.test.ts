/**
 * Regressions from review of PR #336 (#322) for implementation evidence checkboxes:
 * approval-mode detection, prose list ownership, cross-reference blocks and
 * validation of `--previous-index` baselines.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexRepository } from "../src/decision-atlas-cli.ts";
import { buildAtlasIndex, type AtlasIndex } from "../src/decision-atlas.ts";

const repository = "moritzbrantner/evidence-regressions";
const revision = "c".repeat(40);
const sourcePath = "docs/decisions/atlas.md";

const base = `# Regression fixture

## Entries

- **1** Product
  - **1.1** Data
    - **1.1.1** [decision] Records migrate to the new store.
      - [x] **1.2** migration completed.
      - [ ] Rollback is documented.
    - **1.1.2** [decision] Records are versioned.
`;

function build(text: string, previous?: AtlasIndex): AtlasIndex {
  return buildAtlasIndex(
    repository,
    revision,
    [{ path: sourcePath, format: "numbered-list", text }],
    previous,
  );
}

function lineOf(text: string, needle: string): number {
  const index = text.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error("missing line " + needle);
  return index + 1;
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

test("evidence text starting with a bold numeric token does not select approval mode", () => {
  const index = build(base);
  expect(index.decisions.map((decision) => decision.id)).toEqual(["1.1.1", "1.1.2"]);
  expect(index.decisions[0]!.evidence).toEqual([
    { text: "**1.2** migration completed.", checked: true },
    { text: "Rollback is documented.", checked: false },
  ]);
  expect(index.groups.map((group) => group.id)).toEqual(["1", "1.1"]);
});

test("a sibling prose list item ends Decision ownership; a checkbox under it fails closed", () => {
  const text = base.replace(
    "    - **1.1.2** [decision]",
    "    - Notes\n      - [x] Prose checklist item.\n    - **1.1.2** [decision]",
  );
  const message = thrown(() => build(text)).replace(/^Decision Atlas:\s*/u, "");
  expect(message).toContain(`${sourcePath}:${lineOf(text, "Prose checklist item.")}`);
  expect(message).toMatch(/not nested under a decision/iu);

  // A later Decision still owns its own evidence after the prose item.
  const later = base.replace(
    "    - **1.1.2** [decision] Records are versioned.",
    "    - Notes\n    - **1.1.2** [decision] Records are versioned.\n      - [x] Version is stored.",
  );
  expect(build(later).decisions[1]!.evidence).toEqual([
    { text: "Version is stored.", checked: true },
  ]);
});

for (const marker of ["[x] Misplaced evidence.", "[partial] Misplaced evidence."]) {
  test("a checkbox inside a Cross-decision references block fails closed: " + marker, () => {
    const text =
      base +
      "- **Cross-decision references (navigation; no new IDs)**\n" +
      "  - `1.1.1` relies on `1.1.2`.\n" +
      `  - ${marker}\n`;
    const message = thrown(() => build(text));
    expect(message).toContain(`${sourcePath}:${lineOf(text, "Misplaced evidence.")}`);
    expect(message).toMatch(/checkbox/iu);
  });
}

function tamperedPrevious(): AtlasIndex {
  const previous = JSON.parse(JSON.stringify(build(base))) as AtlasIndex;
  (previous.decisions[0]!.evidence![0] as { checked: unknown }).checked = "partial";
  return previous;
}

test("a previous index with malformed v2 evidence is rejected by buildAtlasIndex", () => {
  expect(() => build(base, tamperedPrevious())).toThrow("malformed implementation evidence");
  expect(() => build(base, build(base))).not.toThrow();
});

test("--previous-index runs full index validation, including v2 evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-evidence-regressions-"));
  directories.push(root);
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  writeFileSync(join(root, sourcePath), base, "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Atlas regression");
  git("config", "user.email", "atlas@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const previous = join(root, "..", `${root.split("/").pop()}-previous.json`);
  directories.push(previous);
  const run = () =>
    indexRepository({
      root,
      repository,
      source: sourcePath,
      format: "numbered-list",
      revision: git("rev-parse", "HEAD"),
      previous,
    });
  writeFileSync(previous, JSON.stringify(tamperedPrevious()), "utf8");
  expect(run).toThrow("malformed implementation evidence");
  writeFileSync(previous, JSON.stringify(build(base)), "utf8");
  expect(run().decisions[0]!.evidence).toHaveLength(2);
});
