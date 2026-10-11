import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexRepository } from "../src/decision-atlas-cli.ts";
import { buildAtlasIndex, type AtlasIndex } from "../src/decision-atlas.ts";
import { renderAtlasPreview } from "../src/decision-atlas-preview.ts";

const revision = "a".repeat(40);
const repo = "moritzbrantner/my-farm";
const issue = (id: number) => `[#${id}](https://github.com/${repo}/issues/${id})`;
const source = (
  text: string,
  format: "numbered-list" | "my-farm-tree" | "canonical" = "numbered-list",
) => [{ path: "docs/decisions/atlas.md", format, text }];

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

function canonical(id: string, extras: Record<string, unknown> = {}): string {
  const fields: Record<string, unknown> = {
    atlas_version: 1,
    id,
    parent: null,
    choice: "A",
    path: ["control"],
    decision_status: "accepted",
    implementation_status: "not-verified",
    tags: ["ux"],
    relations: [],
    links: [`https://github.com/${repo}/issues/126`],
    ...extras,
  };
  const serialized = Object.entries(fields).map(
    ([key, value]) =>
      `${key}: ${typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value)}`,
  );
  return `---\n${serialized.join("\n")}\n---\nDo not silently change this decision.\n`;
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
  expect(index.decisions.every((item) => item.decisionStatus === "accepted")).toBe(true);
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

test("canonical YAML-frontmatter sources are typed, versioned, and retain explicit relations", () => {
  const first = canonical("my-farm/control/first");
  const second = canonical("my-farm/control/second", {
    relations: [{ type: "supersedes", target: "my-farm/control/first" }],
    aliases: ["my-farm/control/old-name"],
  });
  const index = buildAtlasIndex(repo, revision, [
    { path: "docs/decisions/001.md", text: first, format: "canonical" },
    { path: "docs/decisions/002.md", text: second, format: "canonical" },
  ]);
  expect(index.decisions[1]?.aliases).toEqual(["my-farm/control/old-name"]);
  expect(index.decisions[1]?.relations).toEqual([
    { type: "supersedes", target: "my-farm/control/first" },
  ]);
  expect(() =>
    buildAtlasIndex(
      repo,
      revision,
      source(canonical("my-farm/control/first", { atlas_version: 2 }), "canonical"),
    ),
  ).toThrow("invalid versioned");
});

test("duplicate IDs, aliases, missing references and missing links fail closed", () => {
  expect(() => atlas(farm.replace("1.1.2**", "1.1.1**"))).toThrow("duplicate ID");
  expect(() => atlas(farm.replace("references 1.1.2", "references 1.9.9"))).toThrow("dangling");
  expect(() => atlas(farm.replaceAll(issue(126), "").replaceAll(issue(153), ""))).toThrow(
    "no source links",
  );
  expect(() => atlas(farm.replace("issues/126", "tree/main"))).toThrow("links must be");
  const collision = canonical("my-farm/control/second", { aliases: ["my-farm/control/first"] });
  expect(() =>
    buildAtlasIndex(repo, revision, [
      {
        path: "docs/decisions/001.md",
        text: canonical("my-farm/control/first"),
        format: "canonical",
      },
      { path: "docs/decisions/002.md", text: collision, format: "canonical" },
    ]),
  ).toThrow("shadows");
});

test("invalid status and parent cycles are rejected independently of source format", () => {
  expect(() =>
    buildAtlasIndex(
      repo,
      revision,
      source(
        canonical("my-farm/control/first", {
          decision_status: "implemented",
        }),
        "canonical",
      ),
    ),
  ).toThrow("invalid decision status");
  const first = canonical("my-farm/control/first", { parent: "my-farm/control/second" });
  const second = canonical("my-farm/control/second", { parent: "my-farm/control/first" });
  expect(() =>
    buildAtlasIndex(repo, revision, [
      { path: "docs/decisions/001.md", text: first, format: "canonical" },
      { path: "docs/decisions/002.md", text: second, format: "canonical" },
    ]),
  ).toThrow("parent cycle");
});

test("append-only compare rejects changed choices and disappearing IDs; category labels may change", () => {
  const previous = atlas();
  expect(() => atlas(farm.replace("**A now; C later**", "**B**"), previous)).toThrow("changed");
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
