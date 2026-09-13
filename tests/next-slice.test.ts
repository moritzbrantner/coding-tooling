import { expect, test } from "bun:test";

import { rankNextSliceCandidates, type NextSliceCandidate } from "../src/next-slice.ts";

function candidate(
  kind: NextSliceCandidate["kind"],
  priority: number,
  key: string,
): NextSliceCandidate {
  return { kind, priority, key, summary: key, source: {} };
}

test("ranks existing integration work before new roadmap and backlog work", () => {
  const ranked = rankNextSliceCandidates([
    candidate("capability-gap", 50, "gap:1"),
    candidate("todo", 40, "todo:a"),
    candidate("issue", 30, "issue:2"),
    candidate("roadmap", 20, "roadmap:a"),
    candidate("pr-review", 10, "pr:2"),
    candidate("pr-reconcile", 0, "pr:1"),
  ]);
  expect(ranked.map((entry) => entry.kind)).toEqual([
    "pr-reconcile",
    "pr-review",
    "roadmap",
    "issue",
    "todo",
    "capability-gap",
  ]);
});

test("uses stable keys to break equal-priority ties", () => {
  const ranked = rankNextSliceCandidates([
    candidate("roadmap", 20, "roadmap:z"),
    candidate("roadmap", 20, "roadmap:a"),
  ]);
  expect(ranked.map((entry) => entry.key)).toEqual(["roadmap:a", "roadmap:z"]);
});
