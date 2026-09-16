import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations } from "../src/expectations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-performance-contract-"));
  roots.push(root);
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        requiredCapabilities: ["benchmark:smoke"],
        capabilityCommands: {
          ".": { "benchmark:smoke": ["bash", "scripts/performance-smoke.sh"] },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function benchmarkFindings(root: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === "benchmark-evidence",
  );
}

describe("performance contract expectation", () => {
  test("requires a performance contract when benchmark:smoke is required", () => {
    const root = fixture();

    const finding = benchmarkFindings(root).find(
      (item) => item.requirement.key === "performance-contract",
    );

    expect(finding?.message).toContain(".performance/contract.json is missing");
    expect(finding?.requirement.expectedArtifact).toBe(".performance/contract.json");
  });

  test("accepts a structurally valid performance contract", () => {
    const root = fixture();
    mkdirSync(join(root, ".performance"), { recursive: true });
    writeFileSync(
      join(root, ".performance", "contract.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          suite: "fixture/smoke",
          scenarios: [
            {
              id: "common-work",
              kind: "common",
              description: "Representative deterministic fixture",
              dimensions: { entities: 16 },
              metrics: [
                {
                  name: "entity_visits",
                  unit: "visits",
                  direction: "lower",
                  signal: "operation-count",
                  blocking: true,
                  budget: { relativeRegressionPercent: 5 },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    expect(
      benchmarkFindings(root).some((item) => item.requirement.key === "performance-contract"),
    ).toBe(false);
  });

  test("reports malformed performance contracts", () => {
    const root = fixture();
    mkdirSync(join(root, ".performance"), { recursive: true });
    writeFileSync(
      join(root, ".performance", "contract.json"),
      `${JSON.stringify({ schemaVersion: 1, suite: "fixture/smoke", scenarios: [] })}\n`,
    );

    const finding = benchmarkFindings(root).find(
      (item) => item.requirement.key === "performance-contract",
    );
    expect(finding?.message).toContain("scenarios must be a non-empty array");
  });

  test("does not require a performance contract without the required smoke capability", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-performance-contract-optout-"));
    roots.push(root);
    writeFileSync(join(root, ".coding-tooling.json"), '{"schemaVersion":1}\n');

    expect(
      benchmarkFindings(root).some((item) => item.requirement.key === "performance-contract"),
    ).toBe(false);
  });
});
