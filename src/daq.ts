import type { AtlasDecision, AtlasIndex, AtlasRelation } from "./decision-atlas.ts";

export type DaqAction = "get" | "find" | "list" | "questions";
export type DaqKind = "all" | "decision" | "question";

export interface DaqQuery {
  action: DaqAction;
  value?: string;
  kind?: DaqKind;
  topic?: string;
  limit?: number;
  includeInactive?: boolean;
}

export interface DaqEntry {
  id: string;
  kind: AtlasDecision["kind"];
  status: AtlasDecision["decisionStatus"];
  text: string;
  path: string[];
  aliases: string[];
  relations: AtlasRelation[];
  source: { path: string; line: number; url: string };
}

export interface DaqResult {
  repository: string;
  revision: string;
  total: number;
  shown: number;
  entries: DaqEntry[];
}

export function activeDecisionText(statement: string): string {
  return statement
    .replace(/~~.*?~~/gu, "")
    .replace(/\s+Legacy alias:\s*\x60[^\x60]+\x60\.?/gu, "")
    .replace(/\s+Tags:\s*(?:\x60[^\x60]+\x60(?:,\s*)?)+\.?/gu, "")
    .replace(/\s+\(\[[^\]]+\]\(https:\/\/[^)]+\)\)/gu, "")
    .replace(/\s+\[[^\]]+\]\(https:\/\/[^)]+\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function scopedId(repository: string, requested: string): string {
  const separator = requested.indexOf(":");
  if (separator === -1) return requested;
  const prefix = requested.slice(0, separator);
  if (prefix !== repository && prefix !== repository.split("/")[1])
    throw new Error("daq: requested ID belongs to another repository: " + requested);
  return requested.slice(separator + 1);
}

function topicMatches(decision: AtlasDecision, topic: string): boolean {
  const needle = topic.trim().toLowerCase();
  return (
    decision.id === needle ||
    decision.id.startsWith(needle + ".") ||
    decision.path.some((part) => part.toLowerCase().includes(needle))
  );
}

function searchScore(decision: AtlasDecision, tokens: string[]): number {
  const text = activeDecisionText(decision.statement).toLowerCase();
  const path = decision.path.join(" ").toLowerCase();
  const tags = decision.tags.map((tag) => tag.toLowerCase());
  const aliases = decision.aliases.map((alias) => alias.toLowerCase());
  let total = 0;
  for (const token of tokens) {
    const score =
      decision.id.toLowerCase() === token || aliases.includes(token)
        ? 12
        : tags.includes(token)
          ? 8
          : text.includes(token)
            ? 5
            : path.includes(token) || decision.id.toLowerCase().includes(token)
              ? 3
              : aliases.some((alias) => alias.includes(token)) ||
                  tags.some((tag) => tag.includes(token))
                ? 2
                : 0;
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

function toResult(index: AtlasIndex, decision: AtlasDecision): DaqEntry {
  const path = decision.source.path;
  const line = decision.source.line;
  return {
    id: decision.id,
    kind: decision.kind,
    status: decision.decisionStatus,
    text: activeDecisionText(decision.statement),
    path: [...decision.path],
    aliases: [...decision.aliases],
    relations: [...decision.relations],
    source: {
      path,
      line,
      url:
        "https://github.com/" +
        index.repository +
        "/blob/" +
        index.sourceRevision +
        "/" +
        path +
        "#L" +
        line,
    },
  };
}

export function queryDecisionAtlas(index: AtlasIndex, query: DaqQuery): DaqResult {
  const limit = query.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("daq: limit must be an integer from 1 to 100");
  const kind = query.kind ?? "all";
  if (kind !== "all" && kind !== "decision" && kind !== "question")
    throw new Error("daq: invalid entry kind");

  if (query.action === "get") {
    const requested = query.value?.trim();
    if (!requested) throw new Error("daq: get requires an ID");
    const id = scopedId(index.repository, requested);
    const entry = index.decisions.find(
      (decision) => decision.id === id || decision.aliases.includes(id),
    );
    if (!entry) throw new Error("daq: unknown ID " + requested);
    return {
      repository: index.repository,
      revision: index.sourceRevision,
      total: 1,
      shown: 1,
      entries: [toResult(index, entry)],
    };
  }

  const tokens =
    query.action === "find"
      ? (query.value ?? "").trim().toLowerCase().split(/\s+/u).filter(Boolean)
      : [];
  if (query.action === "find" && tokens.length === 0)
    throw new Error("daq: find requires search terms");

  const answered = new Set(
    index.decisions
      .filter(
        (decision) =>
          decision.kind === "decision" &&
          decision.decisionStatus !== "superseded" &&
          decision.decisionStatus !== "proposed",
      )
      .flatMap((decision) =>
        decision.relations
          .filter((relation) => relation.type === "answers")
          .map((relation) => relation.target),
      ),
  );
  const scored = index.decisions
    .filter((decision) => {
      if (query.action === "questions" && decision.kind !== "question") return false;
      if (query.action !== "questions" && kind !== "all" && decision.kind !== kind) return false;
      if (!query.includeInactive) {
        if (decision.kind === "decision" && decision.decisionStatus === "superseded") return false;
        if (decision.kind === "question" && answered.has(decision.id)) return false;
      }
      if (query.topic && !topicMatches(decision, query.topic)) return false;
      return true;
    })
    .map((decision) => ({
      decision,
      score: tokens.length === 0 ? 1 : searchScore(decision, tokens),
    }))
    .filter((item) => item.score > 0);
  // Keep only the best bounded set; no unbounded result sorting or output.
  const ranked: typeof scored = [];
  if (query.action === "find") {
    for (const candidate of scored) {
      const before = ranked.findIndex(
        (current) =>
          candidate.score > current.score ||
          (candidate.score === current.score && candidate.decision.id < current.decision.id),
      );
      if (before === -1) ranked.push(candidate);
      else ranked.splice(before, 0, candidate);
      if (ranked.length > limit) ranked.pop();
    }
  } else {
    ranked.push(...scored.slice(0, limit));
  }
  const entries = ranked.map(({ decision }) => toResult(index, decision));
  return {
    repository: index.repository,
    revision: index.sourceRevision,
    total: scored.length,
    shown: entries.length,
    entries,
  };
}
