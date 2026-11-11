import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentEvalsCommand, loadAgentEvalCases } from "../src/agent-evals.ts";

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

const evalCase = (id = "eval/sample", capability = "general/diagnose") => `---
id: "${id}"
capabilities: ["${capability}"]
critical: true
---

# Sample title reveals the answer

## Task

Diagnose the failure.

## Given

- The job failed.

## Required observations

- Classify the failure.
- Preserve the job link.

## Forbidden behavior

- Change product code.

## Acceptable outcomes

- Stop with a diagnosis.
`;

function workspace(content = evalCase()): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-agent-evals-"));
  write(root, "skills/diagnose/SKILL.md", `---\nid: general/diagnose\n---\n\n# Diagnose\n`);
  write(root, "evals/cases/sample.md", content);
  return root;
}

function digest(root: string): string {
  return loadAgentEvalCases(root)[0].digest;
}

function results(root: string, overrides: Record<string, unknown> = {}): string {
  const path = join(root, "results.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      runs: [
        {
          caseId: "eval/sample",
          caseDigest: digest(root),
          observations: [
            { index: 0, status: "met", evidence: "named it" },
            { index: 1, status: "not-exercised", evidence: "no link given" },
          ],
          forbidden: [{ index: 0, occurred: false, evidence: "no change proposed" }],
          outcome: { index: 0, evidence: "stopped" },
          ...overrides,
        },
      ],
    }),
  );
  return path;
}

describe("agent-evals", () => {
  test("validate counts well-formed cases", () => {
    const result = agentEvalsCommand(workspace(), "validate");
    expect(result.status).toBe("passed");
    expect(result.data).toEqual({ cases: 1, critical: 1 });
  });

  test.each([
    ["a mismatched id", evalCase("eval/other"), "id must be eval/sample"],
    ["an unknown capability", evalCase("eval/sample", "general/missing"), "unknown capability"],
    [
      "a missing section",
      evalCase().replace("## Forbidden behavior\n\n- Change product code.\n\n", ""),
      "sections must be exactly",
    ],
    ["an empty section", evalCase().replace("- Stop with a diagnosis.\n", ""), "is empty"],
    [
      "a non-list checklist",
      evalCase().replace("- Change product code.", "Change product code."),
      "flat list",
    ],
  ])("validate rejects %s", (_name, content, message) => {
    const result = agentEvalsCommand(workspace(content), "validate");
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0].message).toContain(message);
  });

  test("a prose outcome section counts as one acceptable outcome", () => {
    const root = workspace(
      evalCase().replace("- Stop with a diagnosis.", "Stop with a diagnosis\nand hand it back."),
    );
    const result = agentEvalsCommand(root, "criteria", { caseId: "eval/sample" });
    expect(result.data.acceptableOutcomes).toEqual(["Stop with a diagnosis and hand it back."]);
  });

  test("brief withholds the title and judging criteria", () => {
    const result = agentEvalsCommand(workspace(), "brief", { caseId: "eval/sample" });
    expect(result.data).toEqual({
      caseId: "eval/sample",
      capabilities: [{ id: "general/diagnose", source: "skills/diagnose/SKILL.md" }],
      task: "Diagnose the failure.",
      given: "- The job failed.",
    });
    const text = JSON.stringify(result.data);
    for (const hidden of [
      "reveals the answer",
      "Classify the failure",
      "Change product code",
      "Stop with",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("criteria binds the checklist to the case digest", () => {
    const root = workspace();
    const result = agentEvalsCommand(root, "criteria", { caseId: "eval/sample" });
    expect(result.data.caseDigest).toBe(digest(root));
    expect(result.data.requiredObservations).toEqual([
      "Classify the failure.",
      "Preserve the job link.",
    ]);
  });

  test("report passes a complete judged run and keeps not-exercised visible", () => {
    const root = workspace();
    const result = agentEvalsCommand(root, "report", { resultsPath: results(root) });
    expect(result.status).toBe("passed");
    const data = result.data as {
      runs: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    expect(data.runs[0].verdict).toBe("passed");
    expect(data.runs[0].notExercised).toEqual(["Preserve the job link."]);
    expect(data.summary).toEqual({
      runs: 1,
      passed: 1,
      failed: 0,
      criticalFailures: [],
      notRun: [],
    });
  });

  test.each([
    ["forbidden behavior", { forbidden: [{ index: 0, occurred: true, evidence: "patched" }] }],
    [
      "a missed observation",
      {
        observations: [
          { index: 0, status: "not-met", evidence: "absent" },
          { index: 1, status: "met", evidence: "kept" },
        ],
      },
    ],
    ["no acceptable outcome", { outcome: null }],
  ])("report fails a critical case on %s", (_name, overrides) => {
    const root = workspace();
    const result = agentEvalsCommand(root, "report", { resultsPath: results(root, overrides) });
    expect(result.status).toBe("failed");
    expect((result.data.summary as { criticalFailures: string[] }).criticalFailures).toEqual([
      "eval/sample",
    ]);
  });

  test.each([
    ["a stale digest", { caseDigest: "sha256:old" }, "different revision"],
    [
      "a partial judgment",
      { observations: [{ index: 0, status: "met", evidence: "named" }] },
      "must judge all 2",
    ],
    [
      "a repeated index",
      {
        observations: [
          { index: 0, status: "met", evidence: "a" },
          { index: 0, status: "met", evidence: "b" },
        ],
      },
      "repeats an index",
    ],
    [
      "missing evidence",
      { forbidden: [{ index: 0, occurred: false, evidence: " " }] },
      "needs evidence",
    ],
    ["an out-of-range outcome", { outcome: { index: 4, evidence: "x" } }, "must be an index"],
  ])("report rejects %s", (_name, overrides, message) => {
    const root = workspace();
    const result = agentEvalsCommand(root, "report", { resultsPath: results(root, overrides) });
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0].message).toContain(message);
  });

  test("report lists cases with no run instead of counting them as passed", () => {
    const root = workspace();
    const path = join(root, "empty.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, runs: [] }));
    const result = agentEvalsCommand(root, "report", { resultsPath: path });
    expect((result.data.summary as { notRun: string[] }).notRun).toEqual(["eval/sample"]);
  });
});
