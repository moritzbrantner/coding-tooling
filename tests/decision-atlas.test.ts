import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexRepository } from "../src/decision-atlas-cli.ts";
import { buildAtlasIndex, validateAtlasIndex, type AtlasIndex } from "../src/decision-atlas.ts";
import { renderAtlasPreview } from "../src/decision-atlas-preview.ts";

const revision = "a".repeat(40);
const repo = "moritzbrantner/my-farm";
const issue = (id: number) => `[#${id}](https://github.com/${repo}/issues/${id})`;
const source = (text: string, format: "numbered-list" | "my-farm-tree" = "numbered-list") => [
  { path: "docs/decisions/atlas.md", format, text },
];

const farm = `- **How to use this Decision Atlas**
  - Explicit IDs and aliases never change.
- **1** Player experience
  - **1.1** Platform
    - **1.1.1** [agreed; implementation unverified] **A now; C later** — Browser-local gameplay first. ${issue(126)}, ${issue(153)}. Tags: \`pages\`, \`platform\`. Legacy alias: \`my-farm/experience/platform/pages-single-player\`.
    - **1.1.2** [agreed; implementation unverified] **B** — Separate approved choice. ${issue(200)}. Tags: \`goals\`. Legacy alias: \`my-farm/production/admission/one-off\`.
  - **1.2** Production
    - **1.2.1** [agreed; implementation unverified] **C** — Newest decision references 1.1.2. ${issue(171)}.
- **Cross-decision references (navigation; no new IDs)**
  - \`1.1.1\` (platform) relies on \`1.1.2\` (goal admission).
- **Authority and pending verification**
  - These are not verified implementations.
`;

function atlas(text = farm, previous?: AtlasIndex): AtlasIndex {
  return buildAtlasIndex(repo, revision, source(text), previous);
}

test("My Farm adapter preserves numeric IDs, original path aliases, choices and explicit relationships", () => {
  const index = atlas();
  expect(index.decisions.map((item) => item.id)).toEqual(["1.1.1", "1.1.2", "1.2.1"]);
  expect(index.decisions[0]?.choice).toBe("A now; C later");
  expect(index.decisions[0]?.aliases).toEqual(["my-farm/experience/platform/pages-single-player"]);
  expect(index.decisions[0]?.path).toEqual(["Player experience", "Platform"]);
  expect(index.decisions[0]?.tags).toEqual(["pages", "platform"]);
  expect(index.decisions[0]?.relations).toEqual([{ type: "cross-reference", target: "1.1.2" }]);
  expect(index.decisions[2]?.relations).toEqual([{ type: "references", target: "1.1.2" }]);
  expect(
    index.decisions.every((item) => item.kind === "decision" && item.decisionStatus === "accepted"),
  ).toBe(true);
  expect(index.decisions.every((item) => item.implementation.verification === "unverified")).toBe(
    true,
  );
  expect(atlas()).toEqual(index);
});

test("numbered MMORPG adapter preserves append-only identities and provenance without reclassifying claims", () => {
  const mm = `- **1** World
  - **1.1** Authority
    - **1.1.1** [implemented in reference] A zone has one writer. ([architecture](https://github.com/moritzbrantner/mmorpg/blob/${revision}/docs/ARCHITECTURE.md))
    - **1.1.2** [owner decision; implementation pending] A duel is nonlethal, see 1.1.1. ([owner PR](https://github.com/moritzbrantner/mmorpg/pull/150))
`;
  const index = buildAtlasIndex("moritzbrantner/mmorpg", revision, source(mm));
  expect(index.groups.map((item) => item.id)).toEqual(["1", "1.1"]);
  expect(index.decisions[0]?.decisionStatus).toBe("recorded");
  expect(index.decisions[1]?.decisionStatus).toBe("accepted");
  expect(index.decisions[0]?.implementation.sourceLabel).toBe("implemented in reference");
  expect(index.decisions[0]?.implementation.verification).toBe("unverified");
  expect(index.decisions[1]?.relations).toEqual([{ type: "references", target: "1.1.1" }]);
});

test("the legacy path-ID My Farm tree remains importable without altering path IDs", () => {
  const tree = `---
decision_status: accepted
implementation_status: not-verified
---
## Hierarchical decisions
- **My Farm**
  - **residents**
    - **control**
      - **\`my-farm/residents/control/hybrid\`** — **C**: Delegate by default. ${issue(126)}. Tags: \`authority\`.
## Cross-branch relationships for the graph
`;
  const index = buildAtlasIndex(repo, revision, source(tree, "my-farm-tree"));
  expect(index.decisions[0]?.id).toBe("my-farm/residents/control/hybrid");
  expect(index.decisions[0]?.choice).toBe("C");
  expect(index.decisions[0]?.path).toEqual(["residents", "control"]);
});

test("the Atlas indexes its own 16 Decisions and 1 Question", () => {
  const markdown = readFileSync(new URL("../docs/decisions/atlas.md", import.meta.url), "utf8");
  const index = buildAtlasIndex("moritzbrantner/coding-tooling", revision, source(markdown));
  expect(index.decisions.filter((entry) => entry.kind === "decision")).toHaveLength(16);
  expect(index.decisions.filter((entry) => entry.kind === "question")).toHaveLength(1);
  expect(index.decisions.find((entry) => entry.id === "4.2.1")?.decisionStatus).toBeNull();
  expect(index.decisions.find((entry) => entry.id === "1.1.1")?.decisionStatus).toBe("accepted");
  expect(index.decisions.find((entry) => entry.id === "2.2.1")?.statement).toContain("~~");
  expect(renderAtlasPreview(index)).toContain("Question: unresolved");
});

test("unresolved Questions remain distinct and can be answered by a later Decision", () => {
  const mm = `- **8** Player interaction
  - **8.1** Duels
    - **8.1.1** [question] Should in-world duels be nonlethal? ([#150](https://github.com/moritzbrantner/mmorpg/pull/150))
    - **8.1.2** [owner decision; implementation pending] In-world duels are nonlethal. Answers 8.1.1. ([#150](https://github.com/moritzbrantner/mmorpg/pull/150))
`;
  const idx = buildAtlasIndex("moritzbrantner/mmorpg", revision, source(mm));
  expect(idx.decisions[0]?.kind).toBe("question");
  expect(idx.decisions[0]?.choice).toBeNull();
  expect(idx.decisions[0]?.decisionStatus).toBeNull();
  expect(idx.decisions[1]?.kind).toBe("decision");
  expect(idx.decisions[1]?.relations).toEqual([{ type: "answers", target: "8.1.1" }]);
  expect(renderAtlasPreview(idx)).toContain("Question: unresolved");
  expect(() =>
    buildAtlasIndex(
      "moritzbrantner/mmorpg",
      revision,
      source(mm.replace("[question] Should", "[question] **A** — Should")),
    ),
  ).toThrow("Question with a selected choice");
});

test("duplicate IDs, aliases and invalid references fail; external links are optional", () => {
  expect(() => atlas(farm.replace("1.1.2**", "1.1.1**"))).toThrow("duplicate ID");
  expect(() => atlas(farm.replace("references 1.1.2", "references 1.9.9"))).toThrow("dangling");
  expect(
    atlas(farm.replaceAll(issue(126), "").replaceAll(issue(153), "")).decisions[0]?.links,
  ).toEqual([]);
  expect(() => atlas(farm.replace("issues/126", "tree/main"))).toThrow("links must be");
  const collision = farm.replace(
    "my-farm/production/admission/one-off",
    "my-farm/experience/platform/pages-single-player",
  );
  expect(() => atlas(collision)).toThrow("duplicate or invalid legacy alias");
});

test("unknown source status and parent cycles fail validation", () => {
  expect(() =>
    atlas(farm.replace("[agreed; implementation unverified]", "[anything goes]")),
  ).toThrow("invalid decision status label");
  const cycle = structuredClone(atlas());
  cycle.decisions[0]!.parentId = "1.1.2";
  cycle.decisions[1]!.parentId = "1.1.1";
  expect(() => validateAtlasIndex(cycle)).toThrow("parent cycle");
});

test("history preserves IDs and choices, but permits concise wording edits", () => {
  const previous = atlas();
  expect(() => atlas(farm.replace("**A now; C later**", "**B**"), previous)).toThrow(
    "historical choice",
  );
  expect(
    atlas(
      farm.replace("Browser-local gameplay first.", "Browser-local gameplay primarily."),
      previous,
    ).decisions[0]?.statement,
  ).toContain("Browser-local gameplay primarily.");
  expect(() =>
    atlas(farm.replace("Legacy alias: `my-farm/production/admission/one-off`.", ""), previous),
  ).toThrow("historical ID my-farm/production/admission/one-off");
  expect(() =>
    atlas(
      farm
        .replace(/\s+- \*\*1\.1\.2\*\*[^\n]*/, "")
        .replace("references 1.1.2", "without a secondary reference")
        .replace(/\s+- `1\.1\.1` \(platform\)[^\n]*/, ""),
      previous,
    ),
  ).toThrow("removed");
  const renamed = farm.replace("**1.1** Platform", "**1.1** Browser delivery");
  expect(atlas(renamed, previous).decisions[0]?.path).toEqual([
    "Player experience",
    "Browser delivery",
  ]);
});

test("strikethrough retires decisions or replaces them inline under the same ID", () => {
  const previous = atlas();
  const retired = atlas(
    farm.replace("**B** — Separate approved choice.", "~~**B** — Separate approved choice.~~"),
    previous,
  );
  expect(retired.decisions[1]?.id).toBe("1.1.2");
  expect(retired.decisions[1]?.decisionStatus).toBe("superseded");
  expect(retired.decisions[1]?.choice).toBeNull();

  const revised = atlas(
    farm.replace(
      "**B** — Separate approved choice.",
      "~~**B** — Separate approved choice.~~ **C** — Revised approved choice.",
    ),
    previous,
  );
  expect(revised.decisions[1]?.choice).toBe("C");
  expect(revised.decisions[1]?.decisionStatus).toBe("accepted");
  expect(revised.decisions[1]?.statement).toContain("~~**B** — Separate approved choice.~~");
  expect(renderAtlasPreview(revised)).toContain("<del>**B** — Separate approved choice.</del>");
  expect(() =>
    atlas(
      farm.replace("**B** — Separate approved choice.", "**C** — Revised approved choice."),
      previous,
    ),
  ).toThrow("historical choice");
});

test("choice-less retirement must preserve the previous statement", () => {
  const original = `- **1** Product
  - **1.1** Backup
    - **1.1.1** [decision] Enable backups.
`;
  const previous = atlas(original);
  expect(atlas(original.replace("Enable backups.", "~~Enable backups.~~"), previous)
    .decisions[0]?.decisionStatus).toBe("superseded");
  expect(() =>
    atlas(original.replace("Enable backups.", "~~Disable backups.~~"), previous),
  ).toThrow("did not preserve previous wording");
});

test("struck references are no longer active and malformed strikethrough fails", () => {
  const revised = atlas(
    farm.replace(
      "**C** — Newest decision references 1.1.2.",
      "**C** — ~~Newest decision references 1.1.2.~~ Newest decision stands alone.",
    ),
  );
  expect(revised.decisions[2]?.relations).toEqual([]);
  expect(() =>
    atlas(farm.replace("Separate approved choice.", "~~Separate approved choice.")),
  ).toThrow("malformed strikethrough");
  const question = `- **8** Product
  - **8.1** Mode
    - **8.1.1** [question] ~~What mode should we use?~~
`;
  expect(() => buildAtlasIndex(repo, revision, source(question))).toThrow(
    "cannot strike a Question",
  );
});

test("the previous path ID can map to a stable legacy alias after a lossless migration", () => {
  const original = buildAtlasIndex(
    repo,
    revision,
    source(
      `## Hierarchical decisions
- **My Farm**
  - **experience**
    - **platform**
      - **\`my-farm/experience/platform/pages-single-player\`** — **A now; C later**: Browser-local gameplay first. ${issue(126)}.
## Cross-branch relationships for the graph
`,
      "my-farm-tree",
    ),
  );
  const migrated = buildAtlasIndex(
    repo,
    revision,
    source(`- **1** Player experience
  - **1.1** Platform
    - **1.1.1** [agreed; implementation unverified] **A now; C later** — Browser-local gameplay first. ${issue(126)}. Legacy alias: \`my-farm/experience/platform/pages-single-player\`.
`),
    original,
  );
  expect(migrated.decisions[0]?.aliases).toContain(original.decisions[0]?.id);
});

test("local preview escapes authored text and supplies a useful hierarchy and source navigation", () => {
  const index = atlas(
    farm.replace("Browser-local gameplay first.", "Escaped <script>alert(1)</script> content."),
  );
  const page = renderAtlasPreview(index);
  expect(page).toContain('id="atlas-filter"');
  expect(page).toContain("Legacy alias");
  expect(page).not.toContain("<script>alert(1)</script>");
  expect(page).toContain("&lt;script&gt;");
  expect(page).toContain(`/blob/${revision}/docs/decisions/atlas.md#L`);
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("revision-bound CLI rejects a stale ref, a dirty source and the wrong repository", () => {
  const root = mkdtempSync(join(tmpdir(), "decision-atlas-"));
  directories.push(root);
  const dir = join(root, "docs", "decisions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "atlas.md");
  writeFileSync(path, farm);
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  run("init", "-q");
  run("config", "user.name", "test");
  run("config", "user.email", "test@example.invalid");
  run("remote", "add", "origin", `https://github.com/${repo}.git`);
  run("add", ".");
  run("commit", "-qm", "fixture");
  const commit = run("rev-parse", "HEAD");
  const options = {
    root,
    repository: repo,
    source: "docs/decisions/atlas.md",
    format: "numbered-list" as const,
    revision: commit,
  };
  expect(indexRepository(options).decisions).toHaveLength(3);
  expect(() => indexRepository({ ...options, revision })).toThrow("stale source revision");
  expect(() => indexRepository({ ...options, repository: "moritzbrantner/mmorpg" })).toThrow(
    "repository identity mismatch",
  );
  writeFileSync(path, farm.replace("Browser-local", "Changed"));
  expect(() => indexRepository(options)).toThrow("uncommitted or stale");
});
