import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations } from "../src/expectations.ts";
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

test("keeps fully deferred capability gaps visible without selecting them again", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-next-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, ".repository.toml"),
    [
      "schema_version = 1",
      'id = "example/repository"',
      'kind = "library"',
      'status = "active"',
      "depends_on = []",
      "consumed_by = []",
      "supersedes = []",
      "replaced_by = []",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }, null, 2),
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

  const finding = analyzeExpectations(root).findings.find(
    (entry) => entry.expectationId === "typescript-source-test",
  );
  expect(finding).toBeDefined();
  writeFileSync(
    join(root, ".coding-tooling.expectations.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        deferrals: [
          {
            id: finding!.id,
            version: 1,
            reason: "already considered for this convergence pass",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const result = nextSliceCommand(root, {
    run: (_command, args = []) => {
      if (args[0] === "repo") {
        return {
          command: ["gh", ...args],
          status: 0,
          stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }),
          stderr: "",
        };
      }
      if (args[0] === "pr") {
        return { command: ["gh", ...args], status: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "issue") {
        return { command: ["gh", ...args], status: 0, stdout: "[]", stderr: "" };
      }
      return {
        command: ["gh", ...args],
        status: 1,
        stdout: "",
        stderr: "unexpected command",
      };
    },
  });

  const candidates = result.data.candidates as NextSliceCandidate[];
  expect(candidates).toContainEqual(
    expect.objectContaining({
      kind: "capability-gap",
      source: expect.objectContaining({ fullyDeferred: true }),
    }),
  );
  expect(result.data.selected).toBeNull();
  expect(result.data.sources).toMatchObject({
    capabilityGaps: { deferred: 1 },
  });
});
