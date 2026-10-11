import { createHash } from "node:crypto";

export type AtlasFormat = "my-farm-tree" | "numbered-list" | "canonical";
export type AtlasDecisionStatus = "accepted" | "recorded" | "proposed" | "superseded";

export interface AtlasRelation {
  type: string;
  target: string;
}

export interface AtlasDecision {
  id: string;
  aliases: string[];
  parentId: string | null;
  path: string[];
  choice: string | null;
  statement: string;
  decisionStatus: AtlasDecisionStatus;
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
  /^(?:[1-9][0-9]*(?:\.[1-9][0-9]*){2,}|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)$/;
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

function fromNumbered(source: AtlasSource): { groups: AtlasGroup[]; decisions: AtlasDecision[] } {
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
    if (crossReferences && /^- \*\*/.test(line)) crossReferences = false;
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
    if (!tagged) fail(`${source.path}:${i + 1} ID ${id} lacks an implementation label`);
    const statusLabel = tagged[1]!;
    const sourceBody = tagged[2]!;
    const selected = sourceBody.match(/^\*\*(.+?)\*\*(?:\s+—\s+|\s+)(.*)$/u);
    const choice = selected ? selected[1]! : null;
    const statement = plainCitationFreeStatement(
      issueFreeStatement(selected ? selected[2]! : sourceBody),
    );
    const aliases = unique(
      [...sourceBody.matchAll(/Legacy alias:\s*`([^`]+)`/g)].map((item) => item[1]!),
    );
    const references = statement.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, "");
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
      id,
      aliases,
      parentId,
      path,
      choice,
      statement,
      decisionStatus:
        statusLabel.includes("owner decision") || statusLabel.includes("agreed")
          ? "accepted"
          : "recorded",
      implementation: { sourceLabel: statusLabel, verification: "unverified" },
      tags: [],
      relations: targets.map((target) => ({ type: "references", target })),
      links: markdownLinks(tagged[2]!),
      source: { path: source.path, line: i + 1 },
    });
  }
  if (decisions.length === 0) fail(`${source.path}: no numbered decisions found`);
  return { groups, decisions };
}

function yamlValue(text: string): unknown {
  if (text.startsWith("[") || text.startsWith("{") || text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      fail(`invalid JSON-compatible YAML value: ${text}`);
    }
  }
  if (text === "null") return null;
  if (text === "true") return true;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^[a-zA-Z0-9._/-]+$/.test(text)) return text;
  fail(`quote YAML scalar ${text}`);
}

function fromCanonical(source: AtlasSource): { groups: AtlasGroup[]; decisions: AtlasDecision[] } {
  const match = source.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match) fail(`${source.path}: missing canonical frontmatter and body`);
  const metadata: Record<string, unknown> = {};
  const allowed = new Set([
    "atlas_version",
    "id",
    "aliases",
    "parent",
    "choice",
    "path",
    "decision_status",
    "implementation_status",
    "tags",
    "relations",
    "links",
  ]);
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = line.match(/^([a-z_]+):\s*(.+)$/);
    if (!field || !allowed.has(field[1]!))
      fail(`${source.path}: unsupported or malformed YAML field ${line}`);
    if (Object.hasOwn(metadata, field[1]!))
      fail(`${source.path}: duplicate YAML field ${field[1]}`);
    metadata[field[1]!] = yamlValue(field[2]!.trim());
  }
  const id = metadata.id;
  const status = metadata.decision_status;
  const path = metadata.path;
  const tags = metadata.tags;
  const relations = metadata.relations;
  const links = metadata.links;
  const parent = metadata.parent ?? null;
  const choice = metadata.choice ?? null;
  const aliases = metadata.aliases ?? [];
  const impl = metadata.implementation_status;
  if (
    metadata.atlas_version !== 1 ||
    typeof id !== "string" ||
    typeof status !== "string" ||
    typeof impl !== "string" ||
    !Array.isArray(path) ||
    !path.every((s) => typeof s === "string") ||
    !Array.isArray(tags) ||
    !tags.every((s) => typeof s === "string") ||
    !Array.isArray(links) ||
    !links.every((s) => typeof s === "string") ||
    !Array.isArray(relations) ||
    !relations.every(
      (r) =>
        !!r &&
        typeof r === "object" &&
        !Array.isArray(r) &&
        Object.keys(r).sort().join(",") === "target,type" &&
        typeof r.target === "string" &&
        typeof r.type === "string",
    ) ||
    (parent !== null && typeof parent !== "string") ||
    !Array.isArray(aliases) ||
    !aliases.every((a) => typeof a === "string") ||
    (choice !== null && typeof choice !== "string")
  )
    fail(`${source.path}: invalid versioned decision metadata`);
  const statement = match[2]!.trim();
  if (!statement) fail(`${source.path}: missing decision text`);
  return {
    groups: [],
    decisions: [
      {
        id,
        aliases: unique(aliases),
        parentId: parent,
        path,
        choice,
        statement,
        decisionStatus: status as AtlasDecisionStatus,
        implementation: { sourceLabel: impl, verification: "unverified" },
        tags: unique(tags),
        relations,
        links: unique(links),
        source: { path: source.path, line: match[1]!.split(/\r?\n/).length + 3 },
      },
    ],
  };
}

function validateLinks(links: string[], repo: string, id: string): void {
  if (links.length === 0) fail(`${id}: no source links`);
  let owned = false;
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
    if (`${match[1]}/${match[2]}` === repo) owned = true;
  }
  if (!owned) fail(`${id}: needs at least one owning-repository source link`);
}

function validateIndex(index: AtlasIndex): void {
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
    if (!decisionStatuses.has(decision.decisionStatus))
      fail(`${decision.id}: invalid decision status`);
    if (
      !decision.implementation.sourceLabel.trim() ||
      decision.implementation.verification !== "unverified"
    )
      fail(`${decision.id}: implementation evidence must remain unverified`);
    if (!decision.statement.trim() || !decision.path.every((label) => label.trim()))
      fail(`${decision.id}: empty decision text or hierarchy`);
    if (decision.choice !== null && !/^[ABC](?:\b|$)/.test(decision.choice))
      fail(`${decision.id}: invalid choice`);
    validateLinks(decision.links, index.repository, decision.id);
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
  const old = new Map(previous.decisions.map((decision) => [decision.id, decision]));
  const now = new Map(
    current.decisions.flatMap((decision) =>
      [decision.id, ...decision.aliases].map((id) => [id, decision] as const),
    ),
  );
  for (const [id, decision] of old) {
    const next = now.get(id);
    if (!next) fail(`historical ID ${id} was removed or renumbered`);
    if (decision.choice !== next.choice || decision.statement !== next.statement)
      fail(`historical decision ${id} changed; append a new ID and supersedes relation instead`);
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
      !/^docs\/decisions\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(source.path) ||
      source.path.includes("..")
    )
      fail(`unsafe source path ${source.path}`);
    if (indexedSources.some((item) => item.path === source.path))
      fail(`duplicate source ${source.path}`);
    const parsed =
      source.format === "my-farm-tree"
        ? fromFarm(source)
        : source.format === "numbered-list"
          ? fromNumbered(source)
          : fromCanonical(source);
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
  validateIndex(index);
  if (previous) assertPreservedDecisions(previous, index);
  return index;
}
