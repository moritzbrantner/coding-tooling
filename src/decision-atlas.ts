import { createHash } from "node:crypto";

import MarkdownIt, { type Env } from "markdown-it";

export type AtlasFormat = "my-farm-tree" | "numbered-list";
export type AtlasEntryKind = "decision" | "question";
export type AtlasDecisionStatus = "accepted" | "recorded" | "proposed" | "superseded";

export interface AtlasRelation {
  type: string;
  target: string;
}

/**
 * One binary implementation-evidence child authored as `- [x] text` / `- [ ] text`
 * under a Decision. `checked` applies only to this narrowly stated child behavior;
 * it never verifies the parent Decision.
 */
export interface AtlasEvidence {
  text: string;
  checked: boolean;
  /**
   * Author-declared anchors from the checkbox line's trailing
   * ` — src: …; test: …; proof: …` tail, in authored order. Absent when the line
   * has none. Anchors are identity only (path + symbol, optional pinned
   * revision); line numbers are derived at resolution time and never stored.
   */
  anchors?: AtlasAnchor[];
}

export type AtlasAnchorKind = "src" | "test" | "proof";

/**
 * One evidence anchor. `src` / `test` name a repository-relative `path` and a
 * language `symbol` (Rust `::` item path, TypeScript `.` path, or a test case),
 * with `revision` only when pinned by `@<sha>`. A `path` prefixed with
 * `<owner>/<repo>:` names another repository. `proof` keeps an immutable GitHub
 * blob `url` and its commit as `revision`. No anchor verifies behavior.
 */
export interface AtlasAnchor {
  kind: AtlasAnchorKind;
  path?: string;
  symbol?: string;
  revision?: string;
  url?: string;
}

/** Derived, display-only progress; never stored in the index. */
export type AtlasEvidenceProgress =
  | { status: "audited"; completed: number; total: number; percent: number }
  | { status: "not-audited" }
  | { status: "not-applicable" };

export interface AtlasDecision {
  kind: AtlasEntryKind;
  id: string;
  aliases: string[];
  parentId: string | null;
  path: string[];
  choice: string | null;
  statement: string;
  decisionStatus: AtlasDecisionStatus | null;
  implementation: { sourceLabel: string; verification: "unverified" };
  tags: string[];
  relations: AtlasRelation[];
  links: string[];
  source: { path: string; line: number };
  /** Always present in schemaVersion 2 indexes; absent from legacy schemaVersion 1 indexes. */
  evidence?: AtlasEvidence[];
}

export interface AtlasGroup {
  id: string;
  parentId: string | null;
  title: string;
}

/** Current emitted index schema. Version 2 adds per-entry `evidence`. */
export const atlasIndexSchemaVersion = 2;
/** Index schema versions accepted as inputs (`--index`, `--previous-index`). */
export const supportedAtlasIndexSchemaVersions: readonly number[] = [1, 2];

export interface AtlasIndex {
  schemaVersion: 1 | 2;
  repository: string;
  sourceRevision: string;
  sources: { path: string; format: AtlasFormat; sha256: string }[];
  groups: AtlasGroup[];
  decisions: AtlasDecision[];
  provenance: {
    source: "committed-revision";
    implementation: "not-verified";
    note: "Source links are declared citations; no code symbol or acceptance test is verified.";
  };
}

export interface AtlasSource {
  path: string;
  format: AtlasFormat;
  text: string;
}

const idPattern =
  /^(?:[1-9][0-9]*(?:\.[1-9][0-9]*)+|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)$/;
const decisionStatuses = new Set(["accepted", "recorded", "proposed", "superseded"]);
const shaPattern = /^[a-f0-9]{40}$/;
const referenceParser = new MarkdownIt("commonmark");
// Only definition metadata is consumed; rendering URL policy must not change
// whether syntactically valid source text defines a reference.
referenceParser.validateLink = () => true;

function fail(message: string): never {
  throw new Error(`Decision Atlas: ${message}`);
}

const anchorKinds = new Set<string>(["src", "test", "proof"]);
const anchorKeys = new Set(["kind", "path", "symbol", "revision", "url"]);
/** `<owner>/<repo>:` prefix of a cross-repository anchor path. */
export const crossRepositoryAnchorPrefix = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):/u;
const proofUrlPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/([a-f0-9]{40})\/[^\s?#]+(?:#[^\s]*)?$/u;

function anchorPathProblem(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return "empty path";
  const local = path.replace(crossRepositoryAnchorPrefix, "");
  if (!local || local !== local.trim() || /\s/u.test(local)) return "empty or space-padded path";
  if (local.startsWith("/") || local.includes("\\") || /^[A-Za-z]:/u.test(local))
    return "path must be repository-relative";
  if (local.split("/").some((piece) => piece === "" || piece === "." || piece === ".."))
    return "path must not contain empty, '.' or '..' segments";
  return undefined;
}

/** Single shape rule for evidence anchors, shared by the Markdown parser and index validation. */
function anchorProblem(anchor: unknown): string | undefined {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return "not an object";
  const value = anchor as Record<string, unknown>;
  if (Object.keys(value).some((key) => !anchorKeys.has(key))) return "unknown anchor field";
  if (typeof value.kind !== "string" || !anchorKinds.has(value.kind))
    return `unknown anchor kind ${String(value.kind)}; use src:, test: or proof:`;
  if (value.kind === "proof") {
    if (value.path !== undefined || value.symbol !== undefined)
      return "a proof anchor has only a URL";
    const match = typeof value.url === "string" ? value.url.match(proofUrlPattern) : null;
    if (!match)
      return "proof must be an immutable https://github.com/<owner>/<repo>/blob/<40-hex sha>/<path> URL";
    if (value.revision !== match[1]) return "proof revision must equal the URL's commit";
    return undefined;
  }
  if (value.url !== undefined) return "only proof anchors carry a URL";
  const pathProblem = anchorPathProblem(value.path);
  if (pathProblem) return pathProblem;
  if (
    typeof value.symbol !== "string" ||
    !value.symbol.trim() ||
    value.symbol !== value.symbol.trim()
  )
    return value.kind === "test" ? "missing test case after ::" : "missing symbol after ::";
  if (
    value.revision !== undefined &&
    (typeof value.revision !== "string" || !shaPattern.test(value.revision))
  )
    return "a pinned revision must be a complete lowercase 40-hex commit SHA";
  return undefined;
}

function parseAnchor(segment: string): AtlasAnchor | string {
  const match = segment.match(/^([A-Za-z]+):\s+(\S.*)$/u);
  if (!match) return "expected <kind>: <value>";
  const kind = match[1]!;
  const value = match[2]!.trim();
  if (!anchorKinds.has(kind)) return `unknown anchor kind ${kind}:; use src:, test: or proof:`;
  if (kind === "proof") {
    const sha = value.match(proofUrlPattern)?.[1];
    return sha
      ? { kind, url: value, revision: sha }
      : (anchorProblem({ kind, url: value }) ?? "invalid proof");
  }
  const separator = value.indexOf("::");
  if (separator === -1)
    return kind === "test" ? "expected <path>::<test case>" : "expected <path>::<symbol>";
  const path = value.slice(0, separator);
  let symbol = value.slice(separator + 2);
  // `Symbol@<sha>` pins a revision; `name @word` (space before @) stays part of a test name.
  const pin = symbol.match(/^(.*\S)@([^\s@]+)$/u);
  const anchor: AtlasAnchor = { kind: kind as AtlasAnchorKind, path, symbol };
  if (pin) {
    symbol = pin[1]!;
    anchor.symbol = symbol;
    anchor.revision = pin[2]!;
  }
  return anchorProblem(anchor) ?? anchor;
}

/**
 * Splits a checkbox line's trailing anchor tail: the first ` — ` (U+2014)
 * immediately followed by `src:`, `test:` or `proof:` starts a `; `-separated
 * list. Any other em dash is prose. Fails closed on any malformed segment.
 */
function splitEvidenceAnchors(text: string, at: string): { text: string; anchors: AtlasAnchor[] } {
  const start = anchorTailStart(text);
  if (start === -1) return { text, anchors: [] };
  const anchors = text
    .slice(start + 3)
    .split("; ")
    .map((segment) => {
      const parsed = parseAnchor(segment.trim());
      if (typeof parsed === "string")
        fail(`${at} malformed evidence anchor "${segment.trim()}": ${parsed}`);
      return parsed;
    });
  const body = text.slice(0, start).trim();
  if (!body) fail(`${at} evidence anchor without evidence text`);
  return { text: body, anchors };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function compareId(left: string, right: string): number {
  if (/^[\d.]+$/.test(left) && /^[\d.]+$/.test(right)) {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! - b[i]!;
    }
    return a.length - b.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function markdownLinks(source: string): string[] {
  return unique([...source.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((match) => match[1]!));
}

function issueFreeStatement(source: string): string {
  return source.replace(/\s+\[#\d+\]\(https:\/\/github\.com\/[^)]*\).*$/u, "").trim();
}

function plainCitationFreeStatement(source: string): string {
  const citation = source.search(/\s+\(\[[^\]]+\]\(https:\/\/github\.com\//u);
  return (citation < 0 ? source : source.slice(0, citation)).trim();
}

function fromFarm(source: AtlasSource): { groups: AtlasGroup[]; decisions: AtlasDecision[] } {
  const lines = source.text.split(/\r?\n/);
  const decisions: AtlasDecision[] = [];
  const categories: { indent: number; title: string }[] = [];
  let withinTree = false;
  let withinRelations = false;
  let status = "accepted";
  let implementation = "not-verified";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const field = line.match(/^(decision_status|implementation_status):\s*(\S+)/);
    if (field && !withinTree) {
      if (field[1] === "decision_status") status = field[2]!;
      else implementation = field[2]!;
    }
    if (line === "## Hierarchical decisions") {
      withinTree = true;
      continue;
    }
    if (line === "## Cross-branch relationships for the graph") {
      withinTree = false;
      withinRelations = true;
      continue;
    }
    if (line.startsWith("## ") && withinRelations) withinRelations = false;
    if (withinTree) {
      if (line.startsWith("## ")) {
        withinTree = false;
        continue;
      }
      const match = line.match(/^(\s*)- \*\*(.+?)\*\*(.*)$/u);
      if (!match) continue;
      const indent = match[1]!.length;
      if (indent % 2 !== 0) fail(`${source.path}:${i + 1} invalid category indentation`);
      const label = match[2]!;
      const remainder = match[3]!;
      if (label.startsWith("`")) {
        const id = label.match(/^`([^`]+)`$/)?.[1];
        if (!id) fail(`${source.path}:${i + 1} malformed decision identifier`);
        const answer = remainder.match(/^\s*—\s*\*\*(.+?)\*\*:\s*(.*)$/u);
        if (!answer) fail(`${source.path}:${i + 1} decision ${id} lacks a choice`);
        const tagMatch = remainder.match(/Tags:\s*((?:`[^`]+`(?:,\s*)?)+)\.?$/u);
        const tags = tagMatch
          ? [...tagMatch[1]!.matchAll(/`([^`]+)`/g)].map((entry) => entry[1]!)
          : [];
        const body = answer[2]!.replace(/\s+Tags:\s*(?:`[^`]+`(?:,\s*)?)+\.?$/u, "");
        decisions.push({
          kind: "decision",
          id,
          aliases: [],
          parentId: null,
          path: categories.filter((c) => c.title !== "My Farm").map((c) => c.title),
          choice: answer[1]!,
          statement: issueFreeStatement(body),
          decisionStatus: status as AtlasDecisionStatus,
          implementation: { sourceLabel: implementation, verification: "unverified" },
          tags: unique(tags),
          relations: [],
          links: markdownLinks(body),
          source: { path: source.path, line: i + 1 },
          evidence: [],
        });
      } else {
        while (categories.length && categories[categories.length - 1]!.indent >= indent)
          categories.pop();
        categories.push({ indent, title: label });
      }
    }
    if (withinRelations) {
      const relation = line.match(/^- \*\*([a-z][a-z-]*)\*\*\s+`([^`]+)`\s+→\s+(.+)$/u);
      if (!relation) continue;
      const node = decisions.find((entry) => entry.id === relation[2]);
      if (!node) fail(`${source.path}:${i + 1} unknown relation source ${relation[2]}`);
      const targets = [...relation[3]!.matchAll(/`([^`]+)`/g)].map((entry) => entry[1]!);
      if (targets.length === 0) fail(`${source.path}:${i + 1} missing relation target`);
      for (const target of targets) node.relations.push({ type: relation[1]!, target });
    }
  }
  if (!withinTree && decisions.length === 0) fail(`${source.path}: no My Farm decisions found`);
  return { groups: [], decisions };
}

function referenceLabel(label: string): string {
  return referenceParser.utils.normalizeReference(label);
}

function approvalReferenceLabels(text: string): ReadonlySet<string> {
  // Let the CommonMark block parser distinguish definitions from literal text,
  // invalid definitions and container content. No rendered HTML is consumed.
  const environment: Env = {};
  referenceParser.parse(text, environment);
  return new Set(Object.keys(environment.references ?? {}));
}

function isApprovalEntryStart(line: string, references: ReadonlySet<string>): boolean {
  const marker = line.match(/^\s*-\s+\[([^\]\r\n]*)\]/u)?.[1];
  // Real checkbox markers remain strict even when a same-named reference exists.
  // Other defined shortcut links are Markdown prose, including bold numeric text.
  if (marker && !/^[xX ]$/u.test(marker) && references.has(referenceLabel(marker))) {
    return false;
  }
  return /^\s*-\s+\[(?:[xX ]?\](?![([])|[^\]\r\n]*\]\s+\*\*|[^\]\r\n]*$)/u.test(line);
}

function fromApprovalChecklist(
  source: AtlasSource,
  referenceLabels: ReadonlySet<string>,
): {
  groups: AtlasGroup[];
  decisions: AtlasDecision[];
} {
  const groups: AtlasGroup[] = [];
  const decisions: AtlasDecision[] = [];
  const approvals = new Map<string, boolean>();
  const parents: { indent: number; entry: AtlasDecision }[] = [];
  const lines = source.text.split(/\r?\n/);
  let group: AtlasGroup | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      const heading = line.match(/^## ([1-9]\d*)\.\s+(.+)$/u);
      group = heading ? { id: heading[1]!, parentId: null, title: heading[2]! } : undefined;
      if (group) {
        groups.push(group);
      }
      parents.length = 0;
      continue;
    }
    if (!isApprovalEntryStart(line, referenceLabels)) continue;
    const match = line.match(/^(\s*)- \[([^\]]*)\] \*\*(\d+(?:\.\d+)*)\*\*\s+(.+)$/u);
    if (!match) {
      if (isApprovalEntryStart(line, referenceLabels)) {
        fail(`${source.path}:${i + 1} malformed approval entry`);
      }
      continue;
    }
    const sourceLine = i + 1;
    const indent = match[1]!.length;
    const checked = match[2] === "x";
    const id = match[3]!;
    if (!group || indent % 2 !== 0 || (match[2] !== "x" && match[2] !== " ")) {
      fail(`${source.path}:${sourceLine} invalid approval entry ${id}`);
    }
    const tagged = match[4]!.match(/^\[([^\]]+)\]\s+(.+)$/u);
    if (tagged && tagged[1] !== "question" && tagged[1] !== "decision") {
      fail(`${source.path}:${sourceLine} invalid entry kind ${tagged[1]}`);
    }
    const kind: AtlasEntryKind = tagged?.[1] === "question" ? "question" : "decision";
    if (kind === "decision" && !checked) {
      fail(`${source.path}:${sourceLine} Decision ${id} is not approved`);
    }
    const text = [tagged ? tagged[2]! : match[4]!];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (!next.trim()) {
        i++;
        continue;
      }
      if (isApprovalEntryStart(next, referenceLabels) || !/^\s+/u.test(next)) {
        break;
      }
      text.push(next.trim());
      i++;
    }
    const statement = text.join(" ");
    const references = statement
      .replace(/~~.*?~~/gu, "")
      .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gu, "");
    const typed = [
      ...references.matchAll(/\b(answers|supersedes)\s+`?([1-9]\d*(?:\.[1-9]\d*)+)`?/giu),
    ].map((edge) => ({ type: edge[1]!.toLowerCase(), target: edge[2]! }));
    const targets = unique(
      [...references.matchAll(/\b[1-9]\d*(?:\.[1-9]\d*)+\b/gu)]
        .map((reference) => reference[0])
        .filter((reference) => reference !== id),
    );
    while (parents.length && parents[parents.length - 1]!.indent >= indent) {
      parents.pop();
    }
    const parent = parents[parents.length - 1]?.entry;
    const entry: AtlasDecision = {
      kind,
      id,
      aliases: [],
      parentId: parent?.id ?? group.id,
      path: parent ? [...parent.path, parent.statement] : [group.title],
      choice: null,
      statement,
      decisionStatus: kind === "question" ? null : "accepted",
      implementation: {
        sourceLabel: kind === "question" ? "not-applicable" : "approved product intent",
        verification: "unverified",
      },
      tags: [],
      relations: targets.map(
        (target) => typed.find((edge) => edge.target === target) ?? { type: "references", target },
      ),
      // v1 structured citations remain issues/PRs/immutable files. General model
      // resource links stay in the source statement, without verification claims.
      links: markdownLinks(statement).filter((link) =>
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues\/\d+|pull\/\d+|blob\/[a-f0-9]{40}\/.+)$/u.test(
          link,
        ),
      ),
      source: { path: source.path, line: sourceLine },
      // Approval checkboxes record owner approval; this variant carries no evidence children.
      evidence: [],
    };
    decisions.push(entry);
    approvals.set(id, checked);
    parents.push({ indent, entry });
  }
  for (const question of decisions.filter((entry) => entry.kind === "question")) {
    const answered = decisions.some(
      (entry) =>
        entry.kind === "decision" &&
        entry.relations.some((edge) => edge.type === "answers" && edge.target === question.id),
    );
    if (approvals.get(question.id) !== answered) {
      fail(`${question.id}: approval checkbox disagrees with its linked answer`);
    }
  }
  if (decisions.length === 0) {
    fail(`${source.path}: no approval entries found`);
  }
  return { groups, decisions };
}

/** A list item enclosing later lines: a numbered entry, a branch, or prose. */
interface AtlasListOwner {
  indent: number;
  id: string;
  entry: AtlasDecision | null;
  prose?: boolean;
}

/**
 * Records one binary evidence child under its nearest owning Decision, failing
 * closed on anything other than exactly `[x]` or `[ ]` followed by text.
 */
function addEvidence(
  source: AtlasSource,
  line: number,
  checkbox: { indent: number; marker: string; rest: string },
  owners: AtlasListOwner[],
): void {
  const at = `${source.path}:${line}`;
  while (owners.length && owners[owners.length - 1]!.indent >= checkbox.indent) owners.pop();
  const owner = owners[owners.length - 1];
  if (!owner?.entry)
    fail(
      `${at} evidence checkbox is not nested under a Decision` +
        (owner
          ? ` (${owner.id} is ${owner.prose ? "a non-entry list item" : "a navigation branch"})`
          : ""),
    );
  if (owner.entry.kind === "question")
    fail(
      `${at} Question ${owner.id} cannot own implementation evidence checkboxes; evidence is not applicable to a question`,
    );
  const text = checkbox.rest.trim();
  if (
    (checkbox.marker !== "x" && checkbox.marker !== " ") ||
    !/^\s+\S/u.test(checkbox.rest) ||
    !text
  )
    fail(
      `${at} malformed implementation evidence checkbox under ${owner.id}; use exactly "- [x] <text>" or "- [ ] <text>"`,
    );
  const anchored = splitEvidenceAnchors(text, at);
  const evidence = owner.entry.evidence!;
  if (evidence.some((item) => item.text === anchored.text))
    fail(`${at} duplicate implementation evidence under ${owner.id}: ${anchored.text}`);
  evidence.push({
    text: anchored.text,
    checked: checkbox.marker === "x",
    ...(anchored.anchors.length ? { anchors: anchored.anchors } : {}),
  });
}

/**
 * File-level discriminator for the owner approval-checklist variant (Video-to-3D):
 * its entries are top-level `- [x] **1.2** ...` approval items and the file has
 * no plain numbered `- **1.2** ...` entries. In an ordinary numbered Atlas,
 * checkbox lines (even ones whose text starts with bold numbers) are nested
 * implementation evidence and never switch the parser.
 */
function isApprovalChecklist(lines: string[], references: ReadonlySet<string>): boolean {
  if (lines.some((line) => /^\s*- \*\*\d+(?:\.\d+)*\*\*\s/u.test(line))) return false;
  return lines.some(
    (line) =>
      isApprovalEntryStart(line, references) &&
      /^-\s+\[[^\]\r\n]*\]\s*\*\*[1-9]\d*(?:\.\d+)*\*\*/u.test(line),
  );
}

/**
 * A list item whose bracketed lead looks like a task-list marker. Markdown links
 * (`[text](url)`), full references (`[text][ref]`), definitions (`[ref]:`) and
 * defined shortcut references are prose, not checkboxes.
 */
function evidenceCheckbox(
  line: string,
  references: ReadonlySet<string>,
): { indent: number; marker: string; rest: string } | null {
  const match = line.match(/^(\s*)-\s+\[([^\]\r\n]*)\](?![([:])(.*)$/u);
  if (!match) return null;
  const marker = match[2]!;
  if (marker !== "x" && marker !== " " && references.has(referenceLabel(marker))) return null;
  return { indent: match[1]!.length, marker, rest: match[3]! };
}

function fromNumbered(source: AtlasSource): { groups: AtlasGroup[]; decisions: AtlasDecision[] } {
  const referenceLabels = approvalReferenceLabels(source.text);
  if (isApprovalChecklist(source.text.split(/\r?\n/u), referenceLabels)) {
    return fromApprovalChecklist(source, referenceLabels);
  }
  const groups: AtlasGroup[] = [];
  const decisions: AtlasDecision[] = [];
  const headings = new Map<string, string>();
  const lines = source.text.split(/\r?\n/);
  let crossReferences = false;
  // Numbered list items that enclose the current line, by indentation, so an
  // evidence checkbox belongs to its nearest owning entry. Cleared outside the list.
  const owners: AtlasListOwner[] = [];
  let withinEntries = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /^#{1,6}(?:\s|$)/u.test(line) ||
      (line.trim() && !/^\s/u.test(line) && !line.startsWith("-"))
    ) {
      // A heading or unindented prose paragraph ends the entries list.
      owners.length = 0;
      withinEntries = false;
    }
    if (line.startsWith("- **Cross-decision references")) {
      crossReferences = true;
      owners.length = 0;
      withinEntries = false;
      continue;
    }
    if (crossReferences && line.startsWith("- **")) crossReferences = false;
    if (crossReferences) {
      if (evidenceCheckbox(line, referenceLabels))
        fail(
          `${source.path}:${i + 1} evidence checkbox inside the Cross-decision references block is not nested under a Decision`,
        );
      const ids = [...line.matchAll(/`([1-9]\d*(?:\.[1-9]\d*){2,})`/g)].map((match) => match[1]!);
      if (ids.length > 1) {
        const origin = decisions.find((item) => item.id === ids[0]);
        if (!origin) fail(`${source.path}:${i + 1} cross-reference source ${ids[0]} is missing`);
        for (const target of ids.slice(1))
          origin.relations.push({ type: "cross-reference", target });
      }
      continue;
    }
    const checkbox = withinEntries ? evidenceCheckbox(line, referenceLabels) : null;
    if (checkbox) {
      addEvidence(source, i + 1, checkbox, owners);
      continue;
    }
    const match = line.match(/^(\s*)- \*\*(\d+(?:\.\d+)*)\*\*\s+(.+)$/u);
    if (!match) {
      // Any other list item (e.g. "- Notes") ends ownership at its indentation, so
      // checkboxes nested under it are not attributed to a preceding Decision.
      const item = withinEntries ? line.match(/^(\s*)(?:[-*+]|\d+[.)])(?:\s|$)/u) : null;
      if (item) {
        const indent = item[1]!.length;
        while (owners.length && owners[owners.length - 1]!.indent >= indent) owners.pop();
        owners.push({ indent, id: `line ${i + 1}`, entry: null, prose: true });
      }
      continue;
    }
    const id = match[2]!;
    const depth = id.split(".").length;
    const indent = match[1]!.length;
    if (indent !== (depth - 1) * 2) fail(`${source.path}:${i + 1} ID ${id} has incorrect nesting`);
    const parentId = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : null;
    const body = match[3]!;
    while (owners.length && owners[owners.length - 1]!.indent >= indent) owners.pop();
    withinEntries = true;
    if (depth < 3) {
      groups.push({ id, parentId, title: body.trim() });
      headings.set(id, body.trim());
      owners.push({ indent, id, entry: null });
      continue;
    }
    const tagged = body.match(/^\[([^\]]+)\]\s+(.+)$/u);
    if (!tagged) fail(`${source.path}:${i + 1} ID ${id} lacks an entry kind/status label`);
    const statusLabel = tagged[1]!;
    const kind: AtlasEntryKind = statusLabel === "question" ? "question" : "decision";
    if (
      kind === "decision" &&
      !/^(?:decision$|agreed|owner decision|implemented|not |documented limit|current limitation|future option)/.test(
        statusLabel,
      )
    )
      fail(`${source.path}:${i + 1} ID ${id} has invalid decision status label ${statusLabel}`);
    const sourceBody = tagged[2]!;
    const struck = [...sourceBody.matchAll(/~~(.*?)~~/g)];
    const activeBody = sourceBody.replace(/~~(.*?)~~/g, "").trim();
    if (activeBody.includes("~~") || struck.some((span) => !span[1]?.trim()))
      fail(`${source.path}:${i + 1} ID ${id} has malformed strikethrough`);
    if (kind === "question" && struck.length > 0)
      fail(`${source.path}:${i + 1} ID ${id} cannot strike a Question`);
    const selected = activeBody.match(/^\*\*([ABC][^*]*)\*\*(?:\s+—\s+|\s+)(.*)$/u);
    const choice = selected ? selected[1]! : null;
    if (kind === "question" && choice !== null)
      fail(`${source.path}:${i + 1} ID ${id} is a Question with a selected choice`);
    const activeStatement = selected ? selected[2]! : activeBody;
    const substantiveText = activeStatement
      .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, "")
      .replace(/\bTags:\s*(?:`[^`]+`(?:,\s*)?)+\.?/gu, "")
      .replace(/\bLegacy alias:\s*`[^`]+`\.?/gu, "")
      .replace(/[-\s.,;:()]+/g, "");
    const retired = kind === "decision" && struck.length > 0 && substantiveText.length === 0;
    // Retain struck history for the Markdown preview; use only live text for active relationships.
    const statement =
      struck.length > 0
        ? sourceBody
        : plainCitationFreeStatement(issueFreeStatement(activeStatement));
    const aliases = unique(
      [...sourceBody.matchAll(/Legacy alias:\s*`([^`]+)`/g)].map((item) => item[1]!),
    );
    const rawTags = sourceBody.match(/\bTags:\s*((?:`[^`]+`(?:,\s*)?)+)/u)?.[1] ?? "";
    const tags = unique([...rawTags.matchAll(/`([^`]+)`/g)].map((tag) => tag[1]!));
    const references = plainCitationFreeStatement(issueFreeStatement(activeStatement)).replace(
      /\[[^\]]+\]\(https?:\/\/[^)]+\)/g,
      "",
    );
    const typed = [
      ...references.matchAll(/\b(answers|supersedes)\s+`?([1-9]\d*(?:\.[1-9]\d*){2,})`?/gi),
    ].map((edgeMatch) => ({ type: edgeMatch[1]!.toLowerCase(), target: edgeMatch[2]! }));
    const targets = unique(
      [...references.matchAll(/\b[1-9]\d*(?:\.[1-9]\d*){2,}\b/g)]
        .map((ref) => ref[0])
        .filter((ref) => ref !== id),
    );
    const path = id
      .split(".")
      .slice(0, -1)
      .map((_, index, parts) => headings.get(parts.slice(0, index + 1).join(".")) ?? "");
    decisions.push({
      kind,
      id,
      aliases,
      parentId,
      path,
      choice,
      statement,
      decisionStatus:
        kind === "question"
          ? null
          : retired
            ? "superseded"
            : statusLabel === "decision" ||
                statusLabel.includes("owner decision") ||
                statusLabel.includes("agreed")
              ? "accepted"
              : "recorded",
      implementation: {
        sourceLabel: kind === "question" ? "not-applicable" : statusLabel,
        verification: "unverified",
      },
      tags,
      relations: targets.map(
        (target) => typed.find((edge) => edge.target === target) ?? { type: "references", target },
      ),
      links: markdownLinks(tagged[2]!),
      source: { path: source.path, line: i + 1 },
      evidence: [],
    });
    owners.push({ indent, id, entry: decisions[decisions.length - 1]! });
  }
  if (decisions.length === 0) fail(`${source.path}: no numbered decisions found`);
  return { groups, decisions };
}

function validateLinks(links: string[], id: string): void {
  // Local file and line already supply provenance; external issue links are optional.
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      fail(`${id}: malformed source URL ${link}`);
    }
    if (url.origin !== "https://github.com" || url.search || url.username || url.password)
      fail(`${id}: unsupported source URL ${link}`);
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/(issues\/\d+|pull\/\d+|blob\/[a-f0-9]{40}\/.+)$/,
    );
    if (!match) fail(`${id}: links must be GitHub issues, PRs or immutable blob URLs: ${link}`);
  }
}

function validateEvidence(index: AtlasIndex, decision: AtlasDecision): void {
  const evidence: unknown = decision.evidence;
  if (index.schemaVersion === 1) {
    if (evidence !== undefined)
      fail(`${decision.id}: schemaVersion 1 indexes predate implementation evidence`);
    return;
  }
  if (!Array.isArray(evidence)) fail(`${decision.id}: implementation evidence must be an array`);
  if (decision.kind === "question" && evidence.length > 0)
    fail(`${decision.id}: implementation evidence is not applicable to a question`);
  const seen = new Set<string>();
  for (const item of evidence as unknown[]) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some((key) => key !== "text" && key !== "checked" && key !== "anchors") ||
      typeof (item as AtlasEvidence).checked !== "boolean" ||
      typeof (item as AtlasEvidence).text !== "string" ||
      !(item as AtlasEvidence).text.trim() ||
      (item as AtlasEvidence).text !== (item as AtlasEvidence).text.trim()
    )
      fail(`${decision.id}: malformed implementation evidence item`);
    const anchors: unknown = (item as AtlasEvidence).anchors;
    if (anchors !== undefined) {
      if (!Array.isArray(anchors)) fail(`${decision.id}: evidence anchors must be an array`);
      for (const anchor of anchors as unknown[]) {
        const problem = anchorProblem(anchor);
        if (problem) fail(`${decision.id}: malformed evidence anchor: ${problem}`);
      }
    }
    const text = (item as AtlasEvidence).text;
    if (seen.has(text)) fail(`${decision.id}: duplicate implementation evidence ${text}`);
    seen.add(text);
  }
}

/**
 * Derived evidence progress. A Decision without audited children is unknown
 * (`not-audited`), never 0%; a Question is `not-applicable`. Completion never
 * implies the parent Decision is implemented or verified.
 */
export function evidenceProgress(decision: AtlasDecision): AtlasEvidenceProgress {
  if (decision.kind === "question") return { status: "not-applicable" };
  const evidence = decision.evidence ?? [];
  if (evidence.length === 0) return { status: "not-audited" };
  const completed = evidence.filter((item) => item.checked).length;
  return {
    status: "audited",
    completed,
    total: evidence.length,
    percent: Math.round((completed / evidence.length) * 100),
  };
}

export function validateAtlasIndex(index: AtlasIndex): void {
  if (!supportedAtlasIndexSchemaVersions.includes(index.schemaVersion))
    fail(`unsupported index schemaVersion ${String(index.schemaVersion)}`);
  const ids = new Set<string>();
  const aliases = new Set<string>();
  const parents = new Map<string, string | null>();
  for (const group of index.groups) {
    if (ids.has(group.id)) fail(`duplicate ID ${group.id}`);
    ids.add(group.id);
    parents.set(group.id, group.parentId);
    if (!group.title.trim()) fail(`empty group ${group.id}`);
  }
  const decisions = new Set<string>();
  for (const decision of index.decisions) {
    if (!idPattern.test(decision.id)) fail(`invalid or missing ID ${decision.id}`);
    if (ids.has(decision.id)) fail(`duplicate ID ${decision.id}`);
    if (decision.kind !== "decision" && decision.kind !== "question")
      fail(`${decision.id}: invalid entry kind`);
    if (
      decision.kind === "decision" &&
      (decision.decisionStatus === null || !decisionStatuses.has(decision.decisionStatus))
    )
      fail(`${decision.id}: invalid decision status`);
    if (
      decision.kind === "question" &&
      (decision.decisionStatus !== null || decision.choice !== null)
    )
      fail(`${decision.id}: unresolved questions must have no decision status or choice`);
    if (
      !decision.implementation.sourceLabel.trim() ||
      decision.implementation.verification !== "unverified"
    )
      fail(`${decision.id}: implementation evidence must remain unverified`);
    if (!decision.statement.trim() || !decision.path.every((label) => label.trim()))
      fail(`${decision.id}: empty decision text or hierarchy`);
    if (decision.choice !== null && !/^[ABC](?:\b|$)/.test(decision.choice))
      fail(`${decision.id}: invalid choice`);
    validateLinks(decision.links, decision.id);
    validateEvidence(index, decision);
    ids.add(decision.id);
    for (const alias of decision.aliases) {
      if (!idPattern.test(alias) || aliases.has(alias) || ids.has(alias) || alias === decision.id)
        fail(`${decision.id}: duplicate or invalid legacy alias ${alias}`);
      aliases.add(alias);
    }
    decisions.add(decision.id);
    parents.set(decision.id, decision.parentId);
  }
  for (const alias of aliases)
    if (ids.has(alias)) fail(`legacy alias shadows a decision ID: ${alias}`);
  for (const [id, parent] of parents) {
    if (parent !== null && !ids.has(parent)) fail(`${id}: missing parent ${parent}`);
    const seen = new Set([id]);
    let current = parent;
    while (current !== null) {
      if (seen.has(current)) fail(`${id}: parent cycle`);
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
  for (const decision of index.decisions) {
    const seen = new Set<string>();
    for (const edge of decision.relations) {
      if (!/^[a-z][a-z-]*$/.test(edge.type)) fail(`${decision.id}: invalid relationship type`);
      if (!decisions.has(edge.target))
        fail(`${decision.id}: dangling ${edge.type} reference to ${edge.target}`);
      const key = `${edge.type}: ${edge.target}`;
      if (seen.has(key)) fail(`${decision.id}: duplicate relationship ${key}`);
      seen.add(key);
    }
  }
}

export function assertPreservedDecisions(previous: AtlasIndex, current: AtlasIndex): void {
  // Evidence children are not part of Decision history; a schemaVersion-1 baseline
  // (without evidence) therefore remains a complete stable-ID baseline.
  if (
    !supportedAtlasIndexSchemaVersions.includes(previous.schemaVersion) ||
    previous.repository !== current.repository
  )
    fail("previous index has a different schema or repository");
  // A baseline must satisfy the same contract as any other index, including v2 evidence.
  validateAtlasIndex(previous);
  const old = new Map(
    previous.decisions.flatMap((decision) =>
      [decision.id, ...decision.aliases].map((id) => [id, decision] as const),
    ),
  );
  const now = new Map(
    current.decisions.flatMap((decision) =>
      [decision.id, ...decision.aliases].map((id) => [id, decision] as const),
    ),
  );
  for (const [id, decision] of old) {
    const next = now.get(id);
    if (!next) fail(`historical ID ${id} was removed or renumbered`);
    if (decision.kind !== next.kind) fail(`historical entry ${id} changed kind`);
    const struck = [...next.statement.matchAll(/~~(.*?)~~/g)].map((span) => span[1]!);
    if (
      decision.kind === "decision" &&
      decision.decisionStatus !== "superseded" &&
      next.decisionStatus === "superseded" &&
      !struck.some((text) => text.includes(decision.statement))
    )
      fail(`retired decision ${id} did not preserve previous wording`);
    if (decision.choice !== next.choice) {
      const preserved = struck.some((text) =>
        decision.choice === null
          ? text.includes(decision.statement)
          : text.includes(`**${decision.choice}**`),
      );
      if (!preserved) fail(`historical choice ${id} changed without striking the previous choice`);
    }
  }
}

export function buildAtlasIndex(
  repository: string,
  sourceRevision: string,
  sources: AtlasSource[],
  previous?: AtlasIndex,
): AtlasIndex {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !shaPattern.test(sourceRevision))
    fail("repository must be owner/name and source revision a complete lowercase commit SHA");
  if (sources.length === 0) fail("no decision sources");
  const sorted = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const groups: AtlasGroup[] = [];
  const decisions: AtlasDecision[] = [];
  const indexedSources: AtlasIndex["sources"] = [];
  for (const source of sorted) {
    if (
      !/^docs\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(source.path) ||
      source.path.includes("..")
    )
      fail(`unsafe source path ${source.path}`);
    if (indexedSources.some((item) => item.path === source.path))
      fail(`duplicate source ${source.path}`);
    const parsed = source.format === "my-farm-tree" ? fromFarm(source) : fromNumbered(source);
    groups.push(...parsed.groups);
    decisions.push(...parsed.decisions);
    indexedSources.push({
      path: source.path,
      format: source.format,
      sha256: createHash("sha256").update(source.text, "utf8").digest("hex"),
    });
  }
  const index: AtlasIndex = {
    schemaVersion: atlasIndexSchemaVersion,
    repository,
    sourceRevision,
    sources: indexedSources,
    groups: groups.sort((a, b) => compareId(a.id, b.id)),
    decisions: decisions
      .sort((a, b) => compareId(a.id, b.id))
      .map((decision) => ({
        ...decision,
        aliases: unique(decision.aliases),
        tags: unique(decision.tags),
        links: unique(decision.links),
        relations: [...decision.relations].sort((a, b) =>
          a.type === b.type ? compareId(a.target, b.target) : a.type < b.type ? -1 : 1,
        ),
        evidence: (decision.evidence ?? []).map((item) =>
          item.anchors
            ? { ...item, anchors: item.anchors.map((anchor) => ({ ...anchor })) }
            : { ...item },
        ),
      })),
    provenance: {
      source: "committed-revision",
      implementation: "not-verified",
      note: "Source links are declared citations; no code symbol or acceptance test is verified.",
    },
  };
  validateAtlasIndex(index);
  if (previous) assertPreservedDecisions(previous, index);
  return index;
}

/** First anchor marker outside inline code spans; a literal `` ` — src: ..` `` stays prose. */
function anchorTailStart(text: string): number {
  for (const match of text.matchAll(/ \u2014 (?:src|test|proof):/gu)) {
    const before = text.slice(0, match.index);
    if ((before.match(/`/g)?.length ?? 0) % 2 === 0) return match.index;
  }
  return -1;
}
