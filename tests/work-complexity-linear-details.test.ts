// Implementation details of the marginal-rate `linear` bound (#309): violation reporting,
// a decreasing first interval, declared-order independence and exact large-counter arithmetic.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workComplexityEvidence } from "../src/work-complexity.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(points: number[], values: number[]) {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-linear-details-"));
  roots.push(root);
  mkdirSync(join(root, ".performance"), { recursive: true });
  const contract = {
    schemaVersion: 2,
    suite: "fixture/linear",
    scenarios: [
      {
        id: "common-work",
        kind: "common",
        description: "Representative deterministic fixture",
        dimensions: { items: points[0]! },
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
    operations: [
      {
        id: "build",
        description: "Build the structure.",
        dimensions: { items: { description: "items" } },
        scalePoints: points.map((items) => ({ items })),
        metrics: [
          {
            name: "operations",
            unit: "operations",
            signal: "operation-count",
            growth: [{ dimension: "items", bound: "linear" }],
          },
        ],
      },
    ],
  };
  writeFileSync(join(root, ".performance/contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  const sha = createHash("sha256")
    .update(readFileSync(join(root, ".performance/contract.json")))
    .digest("hex");
  const evidencePath = join(root, "evidence.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({
      schemaVersion: "coding-tooling/work-evidence/v1",
      suite: "fixture/linear",
      contractSha256: sha,
      operations: [
        {
          id: "build",
          samples: points.map((items, index) => ({
            dimensions: { items },
            metrics: { operations: values[index]! },
          })),
        },
      ],
    }),
  );
  const report = workComplexityEvidence(root, { evidence: evidencePath });
  return { status: report.status, check: report.data.operations[0]!.checks[0]! };
}

describe("linear marginal-rate details (#309)", () => {
  test("names the interval whose marginal work exceeds the first interval's rate", () => {
    const { status, check } = run([10, 20, 30, 40], [19, 39, 59, 100]);
    expect(status).toBe("failed");
    expect(check.violations).toEqual([
      {
        point: { items: 40 },
        value: 100,
        baseline: { items: 10 },
        baselineValue: 19,
        previous: { items: 30 },
        previousValue: 59,
      },
    ]);
  });

  test("orders the group by the bounded dimension, not by declaration order", () => {
    expect(run([40, 10, 30, 20], [79, 19, 59, 39]).status).toBe("passed");
    expect(run([40, 10, 30, 20], [100, 19, 59, 39]).status).toBe("failed");
  });

  test("a decreasing first interval allows later flat or decreasing work only", () => {
    expect(run([10, 20, 30], [50, 40, 40]).status).toBe("passed");
    expect(run([10, 20, 30], [50, 40, 30]).status).toBe("passed");
    expect(run([10, 20, 30], [50, 40, 41]).status).toBe("failed");
  });

  test("flat first interval behaves as a constant tail", () => {
    expect(run([10, 20, 30], [0, 0, 0]).status).toBe("passed");
    expect(run([10, 20, 30], [0, 0, 1]).status).toBe("failed");
  });

  test("uses exact arithmetic near the safe-integer limit", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const a = 2 ** 40;
    // a·x - 1 over large x stays exact; one extra unit at the end is detected.
    const points = [2 ** 12, 2 ** 12 + 1, 2 ** 12 + 2];
    const values = points.map((x) => a * x - 1);
    expect(values.every((value) => value <= max)).toBe(true);
    expect(run(points, values).status).toBe("passed");
    expect(run(points, [values[0]!, values[1]!, values[2]! + 1]).status).toBe("failed");
  });
});
