// Growth classes beyond constant/linear: logarithmic, linearithmic, quadratic, cubic, general
// polynomial (with log factors) and joint product bounds such as O(m · log n). The tolerant rate
// test must accept the declared class (including affine offsets and integer step effects such as
// tree levels) and reject the next faster class. Evaluated with the public
// `workComplexityEvidence` against explicit evidence files.
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

type Point = Record<string, number>;

function evaluate(points: Point[], growth: unknown[], value: (point: Point) => number) {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-classes-"));
  roots.push(root);
  mkdirSync(join(root, ".performance"), { recursive: true });
  const dimensions = Object.keys(points[0]!);
  const contract = {
    schemaVersion: 2,
    suite: "fixture/classes",
    scenarios: [
      {
        id: "common-work",
        kind: "common",
        description: "Representative deterministic fixture",
        dimensions: {},
        metrics: [
          {
            name: "visits",
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
        id: "query",
        description: "Run the query.",
        dimensions: Object.fromEntries(dimensions.map((name) => [name, { description: name }])),
        scalePoints: points,
        metrics: [{ name: "work", unit: "steps", signal: "operation-count", growth }],
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
      suite: "fixture/classes",
      contractSha256: sha,
      operations: [
        {
          id: "query",
          samples: points.map((point) => ({
            dimensions: point,
            metrics: { work: Math.max(0, Math.round(value(point))) },
          })),
        },
      ],
    }),
  );
  return workComplexityEvidence(root, { evidence: evidencePath });
}

function status(sizes: number[], bound: Record<string, unknown>, value: (n: number) => number) {
  return evaluate(
    sizes.map((n) => ({ n })),
    [{ dimension: "n", ...bound }],
    (point) => value(point.n!),
  ).status;
}

const POWERS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const DECADES = [10, 30, 100, 300, 1_000, 3_000, 10_000, 30_000, 100_000];
const log2 = Math.log2;
/** log^1.5 n exceeds log n by a slowly growing factor that a wide tolerance admits. */
const logOneAndHalf = (n: number) => 10 * log2(n) ** 1.5;

describe("logarithmic", () => {
  const bound = { bound: "logarithmic" };
  test("accepts c·log n + b, tree levels and offsets", () => {
    expect(status(POWERS, bound, (n) => 3 * log2(n) + 5)).toBe("passed");
    expect(status(POWERS, bound, (n) => 4 * log2(n) - 20)).toBe("passed");
    // Integer tree levels on sizes that are not powers of two.
    expect(status(DECADES, bound, (n) => 7 * Math.ceil(log2(n / 4)) + 2)).toBe("passed");
    expect(status(DECADES, bound, (n) => 2 * Math.floor(log2(n)))).toBe("passed");
    // Constant and sublogarithmic work stay within the bound.
    expect(status(POWERS, bound, () => 9)).toBe("passed");
    expect(status(POWERS, bound, (n) => 6 * Math.sqrt(log2(n)))).toBe("passed");
  });
  test("rejects log² n, √n and linear work", () => {
    expect(status(POWERS, bound, (n) => 2 * log2(n) ** 2)).toBe("failed");
    expect(status(DECADES, bound, (n) => 3 * Math.sqrt(n))).toBe("failed");
    expect(status(POWERS, bound, (n) => n)).toBe("failed");
  });
});

describe("linearithmic", () => {
  const bound = { bound: "linearithmic" };
  test("accepts n log n with lower-order terms and linear work", () => {
    expect(status(POWERS, bound, (n) => n * log2(n))).toBe("passed");
    expect(status(POWERS, bound, (n) => 2 * n * log2(n) - 3 * n + 40)).toBe("passed");
    expect(status(DECADES, bound, (n) => n * Math.ceil(log2(n)))).toBe("passed");
    expect(status(POWERS, bound, (n) => 5 * n)).toBe("passed");
  });
  test("rejects n log² n and n²", () => {
    expect(status(POWERS, bound, (n) => n * log2(n) ** 2)).toBe("failed");
    expect(status(POWERS, bound, (n) => n * n)).toBe("failed");
  });
});

describe("quadratic and cubic", () => {
  test("quadratic accepts n², n(n-1)/2 and n log n; rejects n² log n and n³", () => {
    const bound = { bound: "quadratic" };
    expect(status(POWERS, bound, (n) => n * n)).toBe("passed");
    expect(status(POWERS, bound, (n) => (n * (n - 1)) / 2)).toBe("passed");
    expect(status(POWERS, bound, (n) => n * log2(n))).toBe("passed");
    expect(status(POWERS, bound, (n) => n * n * log2(n))).toBe("failed");
    expect(status(POWERS, bound, (n) => n ** 3)).toBe("failed");
  });
  test("cubic accepts n³ − n² and rejects n⁴", () => {
    const sizes = [8, 16, 32, 64, 128, 256];
    const bound = { bound: "cubic" };
    expect(status(sizes, bound, (n) => n ** 3 - n * n)).toBe("passed");
    expect(status(sizes, bound, (n) => n ** 4)).toBe("failed");
  });
});

describe("polynomial", () => {
  const sizes = [4, 8, 16, 32, 64];
  test("degree k accepts n^k and rejects n^(k+1)", () => {
    for (const degree of [1, 2, 4, 5]) {
      const bound = { bound: "polynomial", degree };
      expect(status(sizes, bound, (n) => n ** degree + 3)).toBe("passed");
      expect(status(sizes, bound, (n) => n ** (degree + 1))).toBe("failed");
    }
  });
  test("logDegree adds log factors", () => {
    const bound = { bound: "polynomial", degree: 1, logDegree: 2 };
    expect(status(POWERS, bound, (n) => n * log2(n) ** 2)).toBe("passed");
    expect(status(POWERS, bound, (n) => n * log2(n) ** 4)).toBe("failed");
  });
  test("a tolerance widens the allowed rate", () => {
    expect(status(POWERS, { bound: "logarithmic", tolerance: 0 }, logOneAndHalf)).toBe("failed");
    expect(status(POWERS, { bound: "logarithmic", tolerance: 2 }, logOneAndHalf)).toBe("passed");
  });
  test("two scale points use the ratio test with one unit of slack", () => {
    expect(status([1_000, 4_000], { bound: "quadratic" }, (n) => n * n)).toBe("passed");
    expect(status([1_000, 4_000], { bound: "quadratic" }, (n) => n ** 3)).toBe("failed");
    expect(status([1_000, 1_000_000], { bound: "logarithmic" }, (n) => log2(n))).toBe("passed");
    expect(status([1_000, 1_000_000], { bound: "logarithmic" }, (n) => n)).toBe("failed");
  });
});

describe("product bounds", () => {
  const product = {
    product: [
      { dimension: "m", bound: "linear" },
      { dimension: "n", bound: "logarithmic" },
    ],
  };
  // Not a grid: m and n scale together along a diagonal, plus a few off-diagonal points.
  const points: Point[] = [
    { m: 4, n: 64 },
    { m: 8, n: 256 },
    { m: 16, n: 1024 },
    { m: 32, n: 4096 },
    { m: 64, n: 16384 },
    { m: 64, n: 64 },
    { m: 4, n: 16384 },
  ];
  test("O(m · log n) accepts m·⌈log2 n⌉ + m and rejects m·n and m²·log n", () => {
    expect(evaluate(points, [product], (p) => p.m! * Math.ceil(log2(p.n!)) + p.m!).status).toBe(
      "passed",
    );
    expect(evaluate(points, [product], (p) => p.m! * p.n!).status).toBe("failed");
    expect(evaluate(points, [product], (p) => p.m! ** 2 * log2(p.n!)).status).toBe("failed");
  });
  test("reports the product terms and rates of a violation", () => {
    const report = evaluate(points, [product], (p) => p.m! * p.n!);
    const check = report.data.operations[0]!.checks[0]!;
    expect(check.product?.map((term) => term.dimension)).toEqual(["m", "n"]);
    expect(check.tolerance).toBe(0.25);
    const violation = check.violations[0]!;
    expect(violation.upperRate!).toBeGreaterThan(violation.allowedRate!);
  });
  test("per-dimension bounds on a grid hold the other dimension fixed", () => {
    const grid: Point[] = [];
    for (const m of [4, 16, 64]) for (const n of [64, 512, 4096, 32768]) grid.push({ m, n });
    const growth = [
      { dimension: "m", bound: "linear" },
      { dimension: "n", bound: "logarithmic" },
    ];
    expect(evaluate(grid, growth, (p) => p.m! * Math.ceil(log2(p.n!))).status).toBe("passed");
    expect(evaluate(grid, growth, (p) => p.m! * Math.sqrt(p.n!)).status).toBe("failed");
  });
});

describe("contract validation", () => {
  const invalid: [string, unknown][] = [
    ["polynomial without a degree", { dimension: "n", bound: "polynomial" }],
    ["degree on a named class", { dimension: "n", bound: "quadratic", degree: 2 }],
    ["tolerance on an exact class", { dimension: "n", bound: "linear", tolerance: 0.1 }],
    ["negative tolerance", { dimension: "n", bound: "logarithmic", tolerance: -1 }],
    ["single-term product", { product: [{ dimension: "n", bound: "linear" }] }],
    [
      "constant product term",
      {
        product: [
          { dimension: "n", bound: "constant" },
          { dimension: "n", bound: "linear" },
        ],
      },
    ],
  ];
  for (const [name, growth] of invalid)
    test(`refuses ${name}`, () => {
      const report = evaluate([{ n: 8 }, { n: 64 }], [growth], (p) => p.n!);
      expect(report.status).toBe("unavailable");
      expect(report.diagnostics[0]!.code).toBe("performance-contract-invalid");
    });
});
