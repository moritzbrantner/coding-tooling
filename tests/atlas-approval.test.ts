import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daqCommand } from "../src/daq-cli.ts";
import { indexRepository } from "../src/decision-atlas-cli.ts";
import { buildAtlasIndex, validateAtlasIndex, type AtlasIndex } from "../src/decision-atlas.ts";
import { queryDecisionAtlas } from "../src/daq.ts";

const repository = "moritzbrantner/video-to-3d";
const revision = "9e66e206362d74bc855bc66064bef6e4287f6e1b";
const sourcePath = "docs/DECISION-ATLAS.md";
// The committed fixture owns byte identity; a Windows checkout may apply CRLF.
// Read its immutable Git blob instead of treating checkout conversion as an owner edit.
const realSource = execFileSync(
  "git",
  ["show", "HEAD:fixtures/decision-atlas/video-to-3d/DECISION-ATLAS.md"],
  { cwd: new URL("../", import.meta.url), encoding: "utf8" },
);
const minimal = `# Decision Atlas
## 1. Reconstruct the scene
- [x] **1.1** Major scene decomposition is the default.
  Independently editable walls and furniture. See 3.1.1.
- [x] **8.1** [question] Which provider?
  Answered by 4.7.
## 2. Import videos
- [x] **3.1** Real-video gate.
  Three real clips.
  - [x] **3.1.1** Controlled room.
    Independent fixture inventory.
## 6. Run locally on supported devices
- [x] **4.7** Local provider candidate.
  Answers 8.1.
  A candidate is not a measured capability.
- [ ] **8.5** [question] Cloud policy?
  Unresolved; no permission for uploads.
`;
function index(text = realSource, previous?: AtlasIndex) {
  return buildAtlasIndex(
    repository,
    revision,
    [{ path: sourcePath, format: "numbered-list", text }],
    previous,
  );
}
function get(data: AtlasIndex, id: string) {
  return queryDecisionAtlas(data, { action: "get", value: id }).entries[0];
}

const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "atlas-approval-"));
  directories.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, sourcePath), realSource);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Atlas acceptance");
  git("config", "user.email", "atlas@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  git("add", ".");
  git("commit", "-qm", "Pinned owner-source fixture");
  return { root, git };
}
function capture(argv: string[]) {
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

test("real approval checklist retains 45 identities, six authored topics, descriptions and source lines", () => {
  const data = index();
  const sourceIds = [...realSource.matchAll(/^\s*- \[[x ]\] \*\*([\d.]+)\*\*/gm)].map(
    (match) => match[1],
  );
  expect(sourceIds).toHaveLength(45);
  expect(new Set(data.decisions.map((entry) => entry.id))).toEqual(new Set(sourceIds));
  expect(data.groups.map((group) => group.title)).toEqual([
    "Import videos",
    "Reconstruct the scene",
    "Build editable scene objects",
    "Inspect and correct the scene",
    "Export to Blender",
    "Run locally on supported devices",
  ]);
  expect(data.groups.map((group) => group.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  const decision = get(data, "1.1");
  expect(decision?.kind).toBe("decision");
  expect(decision?.status).toBe("accepted");
  expect(decision?.text).toContain("Major scene decomposition is the default.");
  expect(decision?.text).toContain(
    "Disconnected triangles of one mesh do not count as separate objects.",
  );
  expect(decision?.path).toEqual(["Build editable scene objects"]);
  expect(data.decisions.find((entry) => entry.id === "1.1")?.parentId).toBe("3");
  for (const entry of data.decisions) {
    expect(realSource.split("\n")[entry.source.line - 1]).toContain("**" + entry.id + "**");
    expect(entry.source.path).toBe(sourcePath);
    expect(entry.implementation.verification).toBe("unverified");
  }
  expect(data.provenance.implementation).toBe("not-verified");
  expect(data.decisions.find((entry) => entry.id === "3.1.1")?.parentId).toBe("3.1");
  expect(data.decisions.find((entry) => entry.id === "3.1.1")?.path).toContain("Import videos");
  expect(data.sources[0]?.sha256).toBe(createHash("sha256").update(realSource).digest("hex"));
  validateAtlasIndex(data);
  expect(index()).toEqual(data);
});

test("topical historical Questions retain kind and cross-topic answers; navigation link adds no entry", () => {
  const data = index();
  expect(get(data, "8.1")?.kind).toBe("question");
  expect(get(data, "8.1")?.status).toBeNull();
  expect(get(data, "8.1")?.path).toEqual(["Reconstruct the scene"]);
  expect(get(data, "4.7")?.relations).toContainEqual({ type: "answers", target: "8.1" });
  for (const [answer, question] of [
    ["3.8", "3.7"],
    ["4.6", "8.2"],
    ["5.4", "8.3"],
    ["1.7", "8.4"],
  ]) {
    expect(get(data, answer!)?.relations).toContainEqual({ type: "answers", target: question });
    expect(get(data, question!)?.kind).toBe("question");
  }
  expect(
    queryDecisionAtlas(data, { action: "questions" }).entries.map((entry) => entry.id),
  ).toEqual(["8.5"]);
  expect(queryDecisionAtlas(data, { action: "questions", includeInactive: true }).shown).toBe(6);
  expect(get(data, "8.5")?.path).toEqual(["Run locally on supported devices"]);
  expect(data.decisions.find((entry) => entry.id === "8.5")?.parentId).toBe("6");
  expect(queryDecisionAtlas(data, { action: "questions", topic: "Run locally" }).shown).toBe(1);
  expect(
    queryDecisionAtlas(data, { action: "find", value: "decomposition" }).entries.map(
      (entry) => entry.id,
    ),
  ).toContain("1.1");
  expect(get(data, "8.5")?.source.url).toContain("/blob/" + revision + "/" + sourcePath + "#L");
});

test("compact fixture preserves nested IDs and only approval status, with answers in another topic", () => {
  const data = index(minimal);
  expect(data.decisions).toHaveLength(6);
  expect(data.decisions.find((entry) => entry.id === "3.1.1")?.parentId).toBe("3.1");
  expect(get(data, "1.1")?.relations).toContainEqual({ type: "references", target: "3.1.1" });
  expect(get(data, "4.7")?.text).toContain("A candidate is not a measured capability.");
  expect(
    queryDecisionAtlas(data, { action: "questions" }).entries.map((entry) => entry.id),
  ).toEqual(["8.5"]);
  expect(data.decisions.every((entry) => entry.implementation.verification === "unverified")).toBe(
    true,
  );
});

for (const [name, text] of [
  ["unknown reference", minimal.replace("See 3.1.1.", "See 9.9.")],
  ["unknown answering Decision", minimal.replace("Answered by 4.7.", "Answered by 9.9.")],
  ["duplicate ID", minimal + "- [x] **1.1** Duplicate.\n"],
  ["unapproved Decision", minimal.replace("[x] **1.1**", "[ ] **1.1**")],
  ["unknown leaf kind", minimal.replace("**1.1** Major", "**1.1** [constraint] Major")],
  ["invalid checkbox", minimal.replace("[x] **1.1**", "[z] **1.1**")],
]) {
  test("approval source fails deterministically for " + name, () => {
    expect(() => index(minimal)).not.toThrow();
    expect(() => index(text)).toThrow();
  });
}

// Independent review-regression acceptance at 388addf, before parser repair.
// A valid neighboring Decision cannot hide malformed owner-authored identities.
for (const [name, malformed] of [
  ["alphabetic ID component", "- [x] **1.a** This owner entry must not disappear."],
  ["alphabetic first ID component", "- [x] **a.1** This owner entry must not disappear."],
  ["missing closing bold marker", "- [x] **1.2 This owner entry must not disappear."],
  ["indented malformed entry", "  - [x] **1.a** This entry must not become description text."],
  ["empty hierarchical ID component", "- [x] **1..2** This owner entry must not disappear."],
  ["trailing hierarchical separator", "- [x] **1.2.** This owner entry must not disappear."],
]) {
  test("approval source rejects mixed valid and malformed entries: " + name, () => {
    const valid = "# Decision Atlas\n## 1. Topic\n- [x] **1.1** Valid owner decision.\n";
    expect(index(valid).decisions.map((entry) => entry.id)).toEqual(["1.1"]);
    expect(() => index(valid + malformed + "\n")).toThrow();
    expect(() =>
      index(
        "# Decision Atlas\n## 1. Topic\n" + malformed + "\n- [x] **1.1** Valid owner decision.\n",
      ),
    ).toThrow();
  });
}

test("history rejects renumbered IDs and kind changes but permits authored topical relocation", () => {
  const previous = index(minimal);
  expect(() => index(minimal.replace("**1.1**", "**1.9**"), previous)).toThrow("historical ID");
  expect(() => index(minimal.replace("[ ] **8.5** [question]", "[x] **8.5**"), previous)).toThrow(
    "changed kind",
  );
  const relocated = minimal.replace("## 1. Reconstruct the scene", "## 1. Inspect evidence");
  expect(get(index(relocated, previous), "8.1")?.path).toEqual(["Inspect evidence"]);
});

test("ordinary Markdown navigation and citation bullets do not become approval entries", () => {
  const link = "- [Open question](#6-run-locally-on-supported-devices)\n";
  const linked =
    minimal
      .replace("# Decision Atlas\n", "# Decision Atlas\n" + link)
      .replace("## 2. Import videos\n", "## 2. Import videos\n" + link) +
    "- [Source citation](https://example.invalid/source)\n";
  const expected = index(minimal);
  const actual = index(linked);
  expect(actual.decisions.map((entry) => [entry.id, entry.kind, entry.decisionStatus])).toEqual(
    expected.decisions.map((entry) => [entry.id, entry.kind, entry.decisionStatus]),
  );
  expect(actual.groups).toEqual(expected.groups);
  expect(
    queryDecisionAtlas(actual, { action: "questions" }).entries.map((entry) => entry.id),
  ).toEqual(["8.5"]);
});

test("real-source committed CLI queries and index roundtrip are read-only and reject dirty source", () => {
  const { root, git } = checkout();
  const options = {
    root,
    repository,
    source: sourcePath,
    format: "numbered-list" as const,
    revision: git("rev-parse", "HEAD"),
  };
  const data = indexRepository(options);
  expect(data.decisions).toHaveLength(45);
  const argv = ["get", "8.5", "--root", root, "--source", sourcePath, "--json"];
  const result = capture(argv);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(JSON.parse(result.out).entries[0].path).toEqual(["Run locally on supported devices"]);
  expect(JSON.parse(result.out).revision).toBe(options.revision);
  const cache = join(root, ".artifacts", "index.json");
  mkdirSync(join(root, ".artifacts"));
  writeFileSync(cache, JSON.stringify(data));
  expect(capture(["get", "8.5", "--index", cache, "--json"])).toEqual(result);
  expect(git("diff", "--", sourcePath)).toBe("");
  expect(readFileSync(join(root, sourcePath), "utf8")).toBe(realSource);
  expect(capture(["questions", "--root", root, "--source", sourcePath, "--json"]).code).toBe(0);
  writeFileSync(join(root, sourcePath), realSource + "\nOwner edit not yet committed.\n");
  expect(capture(argv).err).toContain("uncommitted or stale");
});
