import { createHash } from "node:crypto";

export type AtlasFormat = "my-farm-tree" | "numbered-list";
export type AtlasEntryKind = "decision" | "question";
export type AtlasDecisionStatus = "accepted" | "recorded" | "proposed" | "superseded";

export interface AtlasRelation {
  type: string;
  target: string;
}

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
}

export interface AtlasGroup {
  id: string;
  parentId: string | null;
  title: string;
}

export interface AtlasIndex {
  schemaVersion: 1;
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

function fail(message: string): never {
  throw new Error(`Decision Atlas: ${message}`);
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

function isApprovalEntryStart(text: string): boolean {
  // Ordinary Markdown link bullets are prose, not approval checkboxes.
  return /^\s*-\s+\[(?![^\]\r\n]*\]\()/mu.test(text);
}

function fromApprovalChecklist(source: AtlasSource): {
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
    const match = line.match(/^(\s*)- \[([^\]]*)\] \*\*(\d+(?:\.\d+)*)\*\*\s+(.+)$/u);
    if (!match) {
      if (isApprovalEntryStart(line)) {
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
      if (isApprovalEntryStart(next) || !/^\s+/u.test(next)) {
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

function fromNumbered(source: AtlasSource): { groups: AtlasGroup[]; decisions: AtlasDecision[] } {
  if (isApprovalEntryStart(source.text)) {
    return fromApprovalChecklist(source);
  }
  const groups: AtlasGroup[] = [];
  const decisions: AtlasDecision[] = [];
  const headings = new Map<string, string>();
  const lines = source.text.split(/\r?\n/);
  let crossReferences = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("- **Cross-decision references")) {
      crossReferences = true;
      continue;
    }
    if (crossReferences && line.startsWith("- **")) crossReferences = false;
    if (crossReferences) {
      const ids = [...line.matchAll(/`([1-9]\d*(?:\.[1-9]\d*){2,})`/g)].map((match) => match[1]!);
      if (ids.length > 1) {
        const origin = decisions.find((item) => item.id === ids[0]);
        if (!origin) fail(`${source.path}:${i + 1} cross-reference source ${ids[0]} is missing`);
        for (const target of ids.slice(1))
          origin.relations.push({ type: "cross-reference", target });
      }
      continue;
    }
    const match = line.match(/^(\s*)- \*\*(\d+(?:\.\d+)*)\*\*\s+(.+)$/u);
    if (!match) continue;
    const id = match[2]!;
    const depth = id.split(".").length;
    if (match[1]!.length !== (depth - 1) * 2)
      fail(`${source.path}:${i + 1} ID ${id} has incorrect nesting`);
    const parentId = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : null;
    const body = match[3]!;
    if (depth < 3) {
      groups.push({ id, parentId, title: body.trim() });
      headings.set(id, body.trim());
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
    });
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

export function validateAtlasIndex(index: AtlasIndex): void {
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
  if (previous.schemaVersion !== 1 || previous.repository !== current.repository)
    fail("previous index has a different schema or repository");
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
    schemaVersion: 1,
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
