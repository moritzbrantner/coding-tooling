import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const workflow = readFileSync(
  resolve(import.meta.dir, "..", ".github", "workflows", "score-history.yml"),
  "utf8",
);

describe("score history workflow", () => {
  test("allows score production to fail long enough to publish its tombstone", () => {
    const scoreStep = workflow.indexOf("- name: Produce repository score snapshot");
    const appendStep = workflow.indexOf("- name: Append score snapshot");
    const publishStep = workflow.indexOf("- name: Publish history branch");
    const surfaceFailureStep = workflow.indexOf("- name: Surface score production failure");

    expect(scoreStep).toBeGreaterThan(-1);
    expect(workflow.slice(scoreStep, appendStep)).toContain("id: score");
    expect(workflow.slice(scoreStep, appendStep)).toContain("continue-on-error: true");
    expect(appendStep).toBeGreaterThan(scoreStep);
    expect(publishStep).toBeGreaterThan(appendStep);
    expect(surfaceFailureStep).toBeGreaterThan(publishStep);
    expect(workflow.slice(surfaceFailureStep)).toContain("steps.score.outcome == 'failure'");
  });

  test("continues capturing ordinary failed repository verification as score evidence", () => {
    const verificationStep = workflow.indexOf("- name: Capture repository verification");
    const scoreStep = workflow.indexOf("- name: Produce repository score snapshot");

    expect(verificationStep).toBeGreaterThan(-1);
    expect(workflow.slice(verificationStep, scoreStep)).toContain("continue-on-error: true");
  });
});
