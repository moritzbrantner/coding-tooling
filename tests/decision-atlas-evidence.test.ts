/**
 * Independent acceptance for moritzbrantner/coding-tooling#322:
 * binary implementation evidence checkboxes nested under stable Decision IDs
 * in the canonical single-file `numbered-list` Atlas, with derived progress.
 *
 * Pinned seam (the issue leaves exact names open; these are the contract):
 *
 * Index (`buildAtlasIndex` -> `AtlasIndex.decisions[]`, JSON output contract):
 *   - Every indexed entry carries `evidence: { text: string; checked: boolean }[]`
 *     (additional per-item fields such as a source line are permitted).
 *     Items keep authored order and belong to the nearest owning Decision,
 *     including checkboxes nested under another checkbox. `text` is the trimmed
 *     authored Markdown after `- [x] ` / `- [ ] `. Questions and Decisions
 *     without children have `evidence: []`.
 *   - Evidence never changes the Decision `statement`, `links`, `relations`,
 *     `choice`, `decisionStatus` or `implementation` (which stays
 *     `verification: "unverified"`), and `provenance.implementation` stays
 *     `"not-verified"`, even when every child is checked or links a merged PR.
 *   - The decision JSON schema documents `evidence`, and the index schema's
 *     `schemaVersion` accepts the emitted version. An older validated index
 *     (schemaVersion 1, no `evidence` keys) stays usable as `--previous-index`
 *     and through `daq --index`, where it reports `not-audited`.
 *
 * Query (`queryDecisionAtlas` -> `DaqEntry`, i.e. `daq ... --json`):
 *   - `evidence: { text, checked }[]` as above.
 *   - `progress` is exactly one of
 *       { status: "audited", completed: number, total: number, percent: number }
 *       { status: "not-audited" }      (Decision with zero children; never 0%)
 *       { status: "not-applicable" }   (Question)
 *     `percent` is display-only: Math.round(completed / total * 100).
 *
 * `daq get` text output: includes `completed/total` and `percent%` for audited
 * Decisions, one `[x] <text>` / `[ ] <text>` line per child in authored order,
 * and "not audited" (case-insensitive) for a Decision without children. It never
 * prints 0% or 0/0 for an unaudited Decision and never claims verification.
 *
 * Preview (`renderAtlasPreview`): each audited Decision's article renders one
 * read-only (`disabled`) `<input type="checkbox">` per child, with the `checked`
 * attribute exactly on checked children, plus `completed/total` and `percent%`;
 * the navigation tree node shows `completed/total`; an unaudited Decision shows
 * "not audited". Evidence text is HTML-escaped.
 *
 * Fail-closed diagnostics (thrown errors, consistent with existing
 * `Decision Atlas: <path>:<line> ...` style):
 *   - malformed checkbox markers (`[X]`, `[-]`, `[~]`, `[x ]`, `[ x]`, `[]`,
 *     `[  ]`, `[partial]`, empty child text): message names `<path>:<line>` and
 *     mentions checkbox/evidence; nothing is silently counted.
 *   - the same child text twice under one Decision (regardless of state):
 *     "duplicate" plus `<path>:<line>` of the second occurrence. The same text
 *     under different Decisions is allowed.
 *   - a checkbox nested under a Question: names the Question ID and "question"
 *     (Questions are not applicable to implementation evidence).
 *   - a checkbox list item inside the entries list but not under any Decision
 *     (e.g. directly under a navigation branch): mentions "decision".
 *   - a tampered index whose `checked` is not a boolean is rejected by
 *     `validateAtlasIndex` / `daq --index`.
 * Checkboxes in ordinary prose (inline text, a checklist under a separate
 * non-entry heading) are ignored.
 *
 * Out of scope here (stated gap): evidence children inside the Video-to-3D
 * owner approval-checklist variant, whose own `- [x] **ID**` boxes mean owner
 * approval. That variant must keep indexing unchanged with no evidence.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daqCommand } from "../src/daq-cli.ts";
import { indexRepository } from "../src/decision-atlas-cli.ts";
import { buildAtlasIndex, validateAtlasIndex, type AtlasIndex } from "../src/decision-atlas.ts";
import { renderAtlasPreview } from "../src/decision-atlas-preview.ts";
import { queryDecisionAtlas } from "../src/daq.ts";

const repository = "moritzbrantner/evidence-fixture";
const revision = "b".repeat(40);
const sourcePath = "docs/decisions/atlas.md";
const pr = "https://github.com/moritzbrantner/evidence-fixture/pull/12";

const fixture = `# Evidence fixture

Owner prose mentions \`- [x]\` markers inline and [x] style notes; neither is evidence.

## Entries

- **1** Product
  - **1.1** Checkout
    - **1.1.1** [decision] **B** — Checkout supports guest buyers. Tags: \`checkout\`. Legacy alias: \`shop/checkout/guest\`.
      - [x] Guest cart persists across reloads.
      - [ ] Guest email is validated before payment.
        - [x] Invalid email shows an inline error.
      - [ ] Guest order appears in the admin list, per 1.1.2.
      - [ ] Admin export includes guest orders.
    - **1.1.2** [decision] Payments use one provider.
    - **1.1.3** [question] Should saved cards be offered?
  - **1.2** Delivery
    - **1.2.1** [decision] Orders ship within two days. Supports [x] style notes in prose.
      - [x] Shipping estimate is shown on the order page.
      - [ ] Late orders notify the buyer.
      - [ ] Carrier tracking is linked.
    - **1.2.2** [decision] Buyers can cancel before shipment.
      - [x] Cancel button is shown before shipment ([merged PR](${pr})).
      - [x] Cancelled orders refund the buyer.

## Notes

- [x] Ordinary prose checklist item unrelated to any Decision.
- [ ] Another ordinary prose checklist item.
`;

/** The same Atlas with every nested evidence line removed. */
const stripped = fixture
  .split("\n")
  .filter((line) => !/^\s+- \[[^\]]*\]/u.test(line))
  .join("\n");

function build(text = fixture, previous?: AtlasIndex): AtlasIndex {
  return buildAtlasIndex(
    repository,
    revision,
    [{ path: sourcePath, format: "numbered-list", text }],
    previous,
  );
}

function entry(index: AtlasIndex, id: string) {
  const found = index.decisions.find((decision) => decision.id === id);
  if (!found) throw new Error("missing " + id);
  return found as typeof found & { evidence?: { text: string; checked: boolean }[] };
}

function evidenceOf(index: AtlasIndex, id: string) {
  return (entry(index, id).evidence ?? null)?.map(({ text, checked }) => ({ text, checked }));
}

function get(index: AtlasIndex, id: string) {
  const result = queryDecisionAtlas(index, { action: "get", value: id }).entries[0] as unknown as
    | (Record<string, unknown> & {
        evidence?: { text: string; checked: boolean }[];
        progress?: unknown;
        text: string;
      })
    | undefined;
  if (!result) throw new Error("missing " + id);
  return result;
}

function lineOf(text: string, needle: string, from = 0): number {
  const lines = text.split("\n");
  for (let i = from; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  throw new Error("missing line " + needle);
}

function insertAfter(text: string, needle: string, line: string): string {
  const lines = text.split("\n");
  const at = lineOf(text, needle);
  lines.splice(at, 0, line);
  return lines.join("\n");
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a diagnostic, but the Atlas was accepted");
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

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-evidence-"));
  directories.push(dir);
  return dir;
}
function checkout(text = fixture) {
  const root = tempDir();
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  const path = join(root, sourcePath);
  writeFileSync(path, text, "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Atlas evidence acceptance");
  git("config", "user.email", "atlas@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  git("add", ".");
  git("commit", "-qm", "evidence fixture");
  return { root, path, git };
}

/** A schemaVersion-1 index as emitted before evidence existed (no `evidence` keys). */
function legacyIndex(): AtlasIndex {
  const legacy = JSON.parse(JSON.stringify(build(stripped))) as AtlasIndex & {
    schemaVersion: number;
  };
  legacy.schemaVersion = 1;
  for (const decision of legacy.decisions) delete (decision as { evidence?: unknown }).evidence;
  return legacy as AtlasIndex;
}

test("fixture yields stable per-Decision counts: mixed 2/5, 1/3, fully checked 2/2, unaudited, Question", () => {
  const index = build();
  expect(get(index, "1.1.1").progress).toEqual({
    status: "audited",
    completed: 2,
    total: 5,
    percent: 40,
  });
  expect(get(index, "1.2.1").progress).toEqual({
    status: "audited",
    completed: 1,
    total: 3,
    percent: 33,
  });
  expect(get(index, "1.2.2").progress).toEqual({
    status: "audited",
    completed: 2,
    total: 2,
    percent: 100,
  });
  expect(get(index, "1.1.2").progress).toEqual({ status: "not-audited" });
  expect(get(index, "1.1.3").progress).toEqual({ status: "not-applicable" });
  expect(get(index, "1.1.2").evidence).toEqual([]);
  expect(get(index, "1.1.3").evidence).toEqual([]);
  expect(build().decisions.map((decision) => decision.id)).toEqual([
    "1.1.1",
    "1.1.2",
    "1.1.3",
    "1.2.1",
    "1.2.2",
  ]);
});

test("nested parse preserves authored order and the nearest owning Decision", () => {
  const index = build();
  expect(evidenceOf(index, "1.1.1")).toEqual([
    { text: "Guest cart persists across reloads.", checked: true },
    { text: "Guest email is validated before payment.", checked: false },
    { text: "Invalid email shows an inline error.", checked: true },
    { text: "Guest order appears in the admin list, per 1.1.2.", checked: false },
    { text: "Admin export includes guest orders.", checked: false },
  ]);
  expect(evidenceOf(index, "1.2.1")).toEqual([
    { text: "Shipping estimate is shown on the order page.", checked: true },
    { text: "Late orders notify the buyer.", checked: false },
    { text: "Carrier tracking is linked.", checked: false },
  ]);
  expect(evidenceOf(index, "1.2.2")).toEqual([
    { text: `Cancel button is shown before shipment ([merged PR](${pr})).`, checked: true },
    { text: "Cancelled orders refund the buyer.", checked: true },
  ]);
  expect(evidenceOf(index, "1.1.2")).toEqual([]);
  expect(evidenceOf(index, "1.1.3")).toEqual([]);
  for (const decision of index.decisions)
    expect(Array.isArray((decision as { evidence?: unknown }).evidence)).toBe(true);
  expect(get(index, "1.1.1").evidence).toEqual(evidenceOf(index, "1.1.1")!);
});

test("parse is deterministic across rebuilds, serialization and CRLF line endings", () => {
  const first = build();
  expect(build()).toEqual(first);
  expect(JSON.stringify(build())).toBe(JSON.stringify(first));
  const crlf = build(fixture.replaceAll("\n", "\r\n"));
  for (const id of ["1.1.1", "1.1.2", "1.1.3", "1.2.1", "1.2.2"]) {
    expect(evidenceOf(crlf, id)).toEqual(evidenceOf(first, id)!);
    expect(get(crlf, id).progress).toEqual(get(first, id).progress);
  }
});

test("checkboxes in ordinary prose are ignored and evidence never rewrites Decision text", () => {
  const withEvidence = build();
  const without = build(stripped);
  for (const plain of without.decisions) {
    const decorated = entry(withEvidence, plain.id);
    expect(decorated.statement).toBe(plain.statement);
    expect(decorated.links).toEqual(plain.links);
    expect(decorated.relations).toEqual(plain.relations);
    expect(decorated.aliases).toEqual(plain.aliases);
    expect(decorated.tags).toEqual(plain.tags);
    expect(decorated.choice).toBe(plain.choice);
    expect(decorated.decisionStatus).toBe(plain.decisionStatus);
    expect(decorated.implementation).toEqual(plain.implementation);
  }
  expect(get(withEvidence, "1.1.1").text).not.toContain("Guest cart");
  expect(entry(withEvidence, "1.1.1").relations).toEqual([]);
  expect(entry(withEvidence, "1.2.2").links).toEqual([]);
  expect(get(withEvidence, "1.2.1").text).toContain("Supports [x] style notes in prose.");
  const all = withEvidence.decisions.flatMap((decision) =>
    ((decision as { evidence?: { text: string }[] }).evidence ?? []).map((item) => item.text),
  );
  expect(all).toHaveLength(10);
  expect(all.join("\n")).not.toContain("Ordinary prose checklist");
  expect(all.join("\n")).not.toContain("Another ordinary prose");
});

test("[x] applies only to its child: fully checked Decisions and merged-PR links stay unverified", () => {
  const index = build();
  const decision = entry(index, "1.2.2");
  expect(decision.implementation.verification).toBe("unverified");
  expect(decision.implementation).toEqual(entry(build(stripped), "1.2.2").implementation);
  expect(decision.decisionStatus).toBe("accepted");
  expect(index.provenance.implementation).toBe("not-verified");
  for (const item of index.decisions) expect(item.implementation.verification).toBe("unverified");
  const json = JSON.stringify(get(index, "1.2.2"));
  expect(json).not.toMatch(/"verified"\s*:\s*true|"verification"\s*:\s*"verified"/u);
  expect(json).not.toMatch(/"implemented"\s*:\s*true/u);
  const text = capture(["get", "1.2.2", "--index", writeIndex(index)]).out;
  for (const line of text.split("\n").filter((value) => /verified/iu.test(value)))
    expect(line).toMatch(/unverified|not (?:independently )?verified/iu);
  expect(article(renderAtlasPreview(index), "1.2.2")).toContain(
    "Implementation not independently verified",
  );
});

const malformed = [
  ["uppercase X", "      - [X] Uppercase marker."],
  ["dash partial state", "      - [-] Partially done."],
  ["tilde partial state", "      - [~] Almost done."],
  ["x with trailing space", "      - [x ] Spaced marker."],
  ["x with leading space", "      - [ x] Spaced marker."],
  ["empty brackets", "      - [] Empty marker."],
  ["double space", "      - [  ] Wide marker."],
  ["word state", "      - [partial] Draft state."],
  ["checked without text", "      - [x]"],
  ["unchecked without text", "      - [ ]   "],
] as const;

for (const [name, line] of malformed) {
  test("malformed evidence checkbox fails closed with its source line: " + name, () => {
    const text = insertAfter(fixture, "**1.1.2** [decision]", line);
    const message = thrown(() => build(text));
    expect(message).toContain(`${sourcePath}:${lineOf(text, "**1.1.2**") + 1}`);
    expect(message).toMatch(/checkbox|evidence/iu);
  });
}

test("duplicate child lines under one Decision fail; the same text under another Decision is allowed", () => {
  const repeated = insertAfter(
    fixture,
    "Admin export includes guest orders.",
    "      - [x] Guest cart persists across reloads.",
  );
  const message = thrown(() => build(repeated));
  expect(message).toMatch(/duplicate/iu);
  const second = lineOf(
    repeated,
    "Guest cart persists across reloads.",
    lineOf(repeated, "Guest cart persists across reloads."),
  );
  expect(message).toContain(`${sourcePath}:${second}`);

  const identical = insertAfter(
    fixture,
    "Admin export includes guest orders.",
    "      - [ ] Admin export includes guest orders.",
  );
  expect(thrown(() => build(identical))).toMatch(/duplicate/iu);

  const elsewhere = insertAfter(
    fixture,
    "Carrier tracking is linked.",
    "      - [x] Guest cart persists across reloads.",
  );
  const index = build(elsewhere);
  expect(get(index, "1.2.1").progress).toEqual({
    status: "audited",
    completed: 2,
    total: 4,
    percent: 50,
  });
  expect(get(index, "1.1.1").progress).toEqual({
    status: "audited",
    completed: 2,
    total: 5,
    percent: 40,
  });
});

test("unresolved Questions are not applicable: a nested checkbox under a Question fails closed", () => {
  const text = insertAfter(
    fixture,
    "**1.1.3** [question]",
    "      - [x] Saved cards are encrypted.",
  );
  const message = thrown(() => build(text));
  expect(message).toContain("1.1.3");
  expect(message).toMatch(/question/iu);
});

test("a checkbox in the entries list that no Decision owns fails closed", () => {
  const text = insertAfter(fixture, "  - **1.2** Delivery", "    - [x] Orphan evidence item.");
  // Ignore the generic "Decision Atlas:" prefix; the diagnostic itself must say why.
  const message = thrown(() => build(text)).replace(/^Decision Atlas:\s*/u, "");
  expect(message).toContain(`${sourcePath}:${lineOf(text, "Orphan evidence item.")}`);
  expect(message).toMatch(/decision/iu);
});

test("stable-ID history: adding, toggling, rewording and removing evidence is not a Decision rewrite", () => {
  const before = build(stripped);
  const added = build(fixture, before);
  expect(added.decisions.map((decision) => decision.id)).toEqual(
    before.decisions.map((decision) => decision.id),
  );
  const toggled = build(
    fixture
      .replace("- [ ] Late orders notify the buyer.", "- [x] Late orders notify the buyer.")
      .replace(
        "- [x] Guest cart persists across reloads.",
        "- [ ] Guest cart persists across reloads.",
      )
      .replace("Carrier tracking is linked.", "Carrier tracking links to the carrier."),
    added,
  );
  expect(get(toggled, "1.2.1").progress).toEqual({
    status: "audited",
    completed: 2,
    total: 3,
    percent: 67,
  });
  expect(get(toggled, "1.1.1").progress).toEqual({
    status: "audited",
    completed: 1,
    total: 5,
    percent: 20,
  });
  expect(entry(toggled, "1.1.1").statement).toBe(entry(added, "1.1.1").statement);
  expect(get(build(stripped, added), "1.1.1").progress).toEqual({ status: "not-audited" });
  expect(() =>
    build(fixture.replace("**B** — Checkout supports", "**A** — Checkout supports"), added),
  ).toThrow("historical choice");
  expect(() => build(fixture.replace("**1.2.2**", "**1.2.3**"), added)).toThrow("historical ID");
});

test("an earlier schemaVersion-1 index without evidence remains an explicit previous baseline", () => {
  const legacy = legacyIndex();
  expect(build(fixture, legacy).decisions.map((decision) => decision.id)).toEqual(
    legacy.decisions.map((decision) => decision.id),
  );
  const { root, git } = checkout();
  const previous = join(tempDir(), "previous.json");
  writeFileSync(previous, JSON.stringify(legacy), "utf8");
  const index = indexRepository({
    root,
    repository,
    source: sourcePath,
    format: "numbered-list",
    revision: git("rev-parse", "HEAD"),
    previous,
  });
  expect(evidenceOf(index, "1.1.1")).toHaveLength(5);
});

function writeIndex(index: unknown): string {
  const path = join(tempDir(), "index.json");
  writeFileSync(path, JSON.stringify(index), "utf8");
  return path;
}

test("daq --index explicitly handles legacy, current, unsupported and tampered indexes", () => {
  const legacy = capture([
    "get",
    "shop/checkout/guest",
    "--index",
    writeIndex(legacyIndex()),
    "--json",
  ]);
  expect(legacy.code).toBe(0);
  const legacyEntry = JSON.parse(legacy.out).entries[0];
  expect(legacyEntry.id).toBe("1.1.1");
  expect(legacyEntry.progress).toEqual({ status: "not-audited" });
  expect(legacyEntry.evidence).toEqual([]);

  const current = capture(["get", "1.1.1", "--index", writeIndex(build()), "--json"]);
  expect(current.code).toBe(0);
  expect(JSON.parse(current.out).entries[0].progress).toEqual({
    status: "audited",
    completed: 2,
    total: 5,
    percent: 40,
  });

  const unsupported = JSON.parse(JSON.stringify(build())) as { schemaVersion: number };
  unsupported.schemaVersion = 99;
  const rejected = capture(["get", "1.1.1", "--index", writeIndex(unsupported)]);
  expect(rejected.code).toBe(1);
  expect(rejected.err).toMatch(/unsupported|schema/iu);

  const tampered = JSON.parse(JSON.stringify(build())) as AtlasIndex;
  (entry(tampered, "1.1.1").evidence![1] as { checked: unknown }).checked = "partial";
  expect(() => validateAtlasIndex(tampered)).toThrow();
  expect(capture(["get", "1.1.1", "--index", writeIndex(tampered)]).code).toBe(1);
});

test("daq get text shows counts, percentage and ordered children; unaudited is never 0%", () => {
  const path = writeIndex(build());
  const audited = capture(["get", "1.1.1", "--index", path]);
  expect(audited.code).toBe(0);
  expect(audited.out).toContain("2/5");
  expect(audited.out).toContain("40%");
  const order = [
    "[x] Guest cart persists across reloads.",
    "[ ] Guest email is validated before payment.",
    "[x] Invalid email shows an inline error.",
    "[ ] Guest order appears in the admin list, per 1.1.2.",
    "[ ] Admin export includes guest orders.",
  ].map((line) => audited.out.indexOf(line));
  expect(order.every((position) => position >= 0)).toBe(true);
  expect(order.every((position, i) => i === 0 || position > order[i - 1]!)).toBe(true);

  const unaudited = capture(["get", "1.1.2", "--index", path]);
  expect(unaudited.code).toBe(0);
  expect(unaudited.out).toMatch(/not audited/iu);
  expect(unaudited.out).not.toMatch(/\b0%|\b0\/0\b/u);

  const question = capture(["get", "1.1.3", "--index", path]);
  expect(question.code).toBe(0);
  expect(question.out).not.toMatch(/%|\b0\/0\b/u);
  expect(question.out).not.toMatch(/not audited/iu);
});

test("daq reads the committed source Atlas and rejects an uncommitted checkbox edit", () => {
  const { root, path } = checkout();
  const result = capture(["get", "1.1.1", "--root", root, "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).entries[0].progress).toEqual({
    status: "audited",
    completed: 2,
    total: 5,
    percent: 40,
  });
  writeFileSync(
    path,
    fixture.replace("- [ ] Admin export includes", "- [x] Admin export includes"),
    "utf8",
  );
  const stale = capture(["get", "1.1.1", "--root", root, "--json"]);
  expect(stale.code).toBe(1);
  expect(stale.err).toContain("uncommitted or stale");
  expect(readFileSync(path, "utf8")).toContain("- [x] Admin export includes");
});

function article(page: string, id: string): string {
  const start = page.indexOf(`<article id="decision-${encodeURIComponent(id)}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return page.slice(start, page.indexOf("</article>", start));
}

function navNode(page: string, id: string): string {
  const start = page.indexOf(`href="#decision-${encodeURIComponent(id)}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return page.slice(start, page.indexOf("</a>", start));
}

test("offline tree preview renders read-only child checkboxes, counts and not-audited state", () => {
  const index = build(
    fixture.replace("Carrier tracking is linked.", "Carrier <b>tracking</b> is linked."),
  );
  const page = renderAtlasPreview(index);
  const mixed = article(page, "1.1.1");
  const boxes = [...mixed.matchAll(/<input\b[^>]*>/gu)]
    .map((match) => match[0])
    .filter((tag) => /type="checkbox"/u.test(tag));
  expect(boxes).toHaveLength(5);
  expect(boxes.every((tag) => /\bdisabled\b/u.test(tag))).toBe(true);
  expect(boxes.map((tag) => /\schecked\b/u.test(tag))).toEqual([true, false, true, false, false]);
  expect(mixed).toContain("Guest cart persists across reloads.");
  expect(mixed).toContain("2/5");
  expect(mixed).toContain("40%");
  expect(mixed).toContain("Implementation not independently verified");
  expect(navNode(page, "1.1.1")).toContain("2/5");
  expect(navNode(page, "1.2.2")).toContain("2/2");

  const unaudited = article(page, "1.1.2");
  expect(unaudited).toMatch(/not audited/iu);
  expect(unaudited).not.toMatch(/\b0%|\b0\/0\b/u);
  expect(unaudited).not.toMatch(/type="checkbox"/u);
  expect(article(page, "1.1.3")).not.toMatch(/type="checkbox"|%/u);

  const escaped = article(page, "1.2.1");
  expect(escaped).not.toContain("<b>tracking</b>");
  expect(escaped).toContain("&lt;b&gt;tracking&lt;/b&gt;");
  expect(renderAtlasPreview(index)).toBe(page);
});

test("JSON output schemas document evidence and accept the emitted schema version", () => {
  const decisionSchema = JSON.parse(
    readFileSync(
      new URL("../schemas/decision-atlas-decision.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const indexSchema = JSON.parse(
    readFileSync(new URL("../schemas/decision-atlas-index.schema.json", import.meta.url), "utf8"),
  );
  const index = build();
  for (const decision of index.decisions)
    for (const key of Object.keys(decision))
      expect(Object.keys(decisionSchema.properties)).toContain(key);
  const evidence = decisionSchema.properties.evidence;
  expect(evidence?.type).toBe("array");
  expect(JSON.stringify(evidence)).toContain('"boolean"');
  const version = indexSchema.properties.schemaVersion;
  const accepted: unknown[] = version.const !== undefined ? [version.const] : (version.enum ?? []);
  expect(accepted).toContain(index.schemaVersion);
});

/** A checkbox-free numbered Atlas (no evidence, no prose checklist). */
const plainAtlas = stripped.slice(0, stripped.indexOf("## Notes"));

test("regression: numbered-list, My Farm tree, approval checklist and legacy aliases still index", () => {
  const plain = build(plainAtlas);
  expect(plain.decisions.map((decision) => decision.id)).toEqual([
    "1.1.1",
    "1.1.2",
    "1.1.3",
    "1.2.1",
    "1.2.2",
  ]);
  expect(get(plain, "shop/checkout/guest").id).toBe("1.1.1");
  expect(get(plain, "evidence-fixture:1.1.1").id).toBe("1.1.1");
  expect(entry(plain, "1.1.1").choice).toBe("B");
  expect(entry(plain, "1.1.3").kind).toBe("question");
  const farm = buildAtlasIndex("moritzbrantner/my-farm", revision, [
    {
      path: sourcePath,
      format: "my-farm-tree",
      text: `## Hierarchical decisions
- **My Farm**
  - **residents**
    - **control**
      - **\`my-farm/residents/control/hybrid\`** — **C**: Delegate by default.
## Cross-branch relationships for the graph
`,
    },
  ]);
  expect(farm.decisions.map((decision) => decision.id)).toEqual([
    "my-farm/residents/control/hybrid",
  ]);
  const approvalSource = execFileSync(
    "git",
    ["show", "HEAD:fixtures/decision-atlas/video-to-3d/DECISION-ATLAS.md"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" },
  );
  expect(
    buildAtlasIndex("moritzbrantner/video-to-3d", "9e66e206362d74bc855bc66064bef6e4287f6e1b", [
      { path: "docs/DECISION-ATLAS.md", format: "numbered-list", text: approvalSource },
    ]).decisions,
  ).toHaveLength(45);
});

test("compatibility adapters and legacy aliases keep working with no evidence", () => {
  const tree = `## Hierarchical decisions
- **My Farm**
  - **residents**
    - **control**
      - **\`my-farm/residents/control/hybrid\`** — **C**: Delegate by default. Tags: \`authority\`.
## Cross-branch relationships for the graph
`;
  const farm = buildAtlasIndex("moritzbrantner/my-farm", revision, [
    { path: sourcePath, format: "my-farm-tree", text: tree },
  ]);
  expect(farm.decisions[0]?.id).toBe("my-farm/residents/control/hybrid");
  expect(evidenceOf(farm, "my-farm/residents/control/hybrid")).toEqual([]);
  expect(get(farm, "my-farm/residents/control/hybrid").progress).toEqual({
    status: "not-audited",
  });

  const plain = build(plainAtlas);
  for (const decision of plain.decisions)
    expect(get(plain, decision.id).progress).toEqual(
      decision.kind === "question" ? { status: "not-applicable" } : { status: "not-audited" },
    );

  const index = build();
  expect(get(index, "shop/checkout/guest").id).toBe("1.1.1");
  expect(get(index, "shop/checkout/guest").progress).toEqual(get(index, "1.1.1").progress);
  expect(get(index, "evidence-fixture:1.1.1").evidence).toEqual(get(index, "1.1.1").evidence!);

  const approvalSource = execFileSync(
    "git",
    ["show", "HEAD:fixtures/decision-atlas/video-to-3d/DECISION-ATLAS.md"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" },
  );
  const approval = buildAtlasIndex(
    "moritzbrantner/video-to-3d",
    "9e66e206362d74bc855bc66064bef6e4287f6e1b",
    [{ path: "docs/DECISION-ATLAS.md", format: "numbered-list", text: approvalSource }],
  );
  expect(approval.decisions).toHaveLength(45);
  for (const decision of approval.decisions) {
    expect(evidenceOf(approval, decision.id)).toEqual([]);
    expect(get(approval, decision.id).progress).toEqual(
      decision.kind === "question" ? { status: "not-applicable" } : { status: "not-audited" },
    );
  }
});
