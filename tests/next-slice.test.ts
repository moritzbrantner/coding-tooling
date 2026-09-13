import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nextSliceCommand,
  rankNextSliceCandidates,
  type NextSliceCandidate,
} from "../src/next-slice.ts";

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

test("discovers only TODO markers written as source comments", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-next-"));
  writeFileSync(join(root, "README.md"), "Documentation mentions actionable `TODO:` markers.\n");
  writeFileSync(
    join(root, "example.ts"),
    [
      'const fixture = "TODO: not backlog";',
      "// TODO: implement source-comment work",
      "// ordinary comment",
    ].join("\n"),
  );

  const result = nextSliceCommand(root, {
    run: () => ({ command: ["gh"], status: 1, stdout: "", stderr: "offline" }),
  });
  const candidates = result.data.candidates as NextSliceCandidate[];
  expect(candidates.filter((entry) => entry.kind === "todo")).toEqual([
    expect.objectContaining({ summary: "implement source-comment work" }),
  ]);
});

test("does not select lower-priority local work when PR inventory is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-next-"));
  writeFileSync(join(root, "example.ts"), "// TODO: tempting lower-priority work\n");

  const result = nextSliceCommand(root, {
    run: () => ({ command: ["gh"], status: 1, stdout: "", stderr: "offline" }),
  });
  expect(result.status).toBe("unavailable");
  expect(result.data.selected).toBeNull();
  expect(result.data.blockedBy).toBe("pull-request-inventory");
});
