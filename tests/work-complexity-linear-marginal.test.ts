// Acceptance for #309: the `linear` growth bound accepts any affine work a·x + b with a >= 0,
// including a negative fixed term (2n-1, 5n-4), and still rejects growth whose per-unit
// marginal work increases (N log N, N², convex sequences). Evaluated with the public
// `workComplexityEvidence` against an explicit evidence file.
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

function run(points: number[], value: (x: number) => number) {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-linear-marginal-"));
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
          samples: points.map((items) => ({
            dimensions: { items },
            metrics: { operations: value(items) },
          })),
        },
      ],
    }),
  );
  return workComplexityEvidence(root, { evidence: evidencePath });
}

const POWERS = [64, 128, 256, 512, 1024, 2048, 4096];

describe("linear growth bound (#309)", () => {
  test("accepts linear work with a negative fixed term", () => {
    expect(run(POWERS, (n) => 2 * n - 1).status).toBe("passed");
    expect(run(POWERS, (n) => 5 * n - 4).status).toBe("passed");
    expect(run([1_000, 10_000, 100_000], (n) => 3 * n - 999).status).toBe("passed");
  });

  test("still accepts proportional work and a non-negative fixed overhead", () => {
    expect(run(POWERS, (n) => n).status).toBe("passed");
    expect(run(POWERS, (n) => 2 * n + 7).status).toBe("passed");
    expect(run(POWERS, () => 3).status).toBe("passed");
  });

  test("accepts sublinear (concave) growth", () => {
    expect(run(POWERS, (n) => Math.round(Math.sqrt(n) * 64)).status).toBe("passed");
  });

  test("rejects growth whose marginal work keeps increasing", () => {
    expect(run(POWERS, (n) => n * Math.log2(n)).status).toBe("failed");
    expect(run(POWERS, (n) => n * n).status).toBe("failed");
    // Linear at first, then a steeper slope at the largest scale point only.
    expect(run(POWERS, (n) => (n < 4096 ? 2 * n - 1 : 2 * n - 1 + 64)).status).toBe("failed");
  });

  test("two scale points keep a deterministic verdict", () => {
    expect(run([1_000, 2_000], (n) => 2 * n).status).toBe("passed");
    expect(run([1_000, 2_000], (n) => n * n).status).toBe("failed");
  });
});
