// Acceptance for #300: operation-level work complexity contracts.
//
// Public surface pinned here (independent acceptance, written before any implementation):
// - `.performance/contract.json` schemaVersion 2 = the v1 contract plus optional `operations`.
//   Each operation declares named `dimensions`, explicit `scalePoints` (one value per dimension)
//   and deterministic `metrics` with an optional absolute `budget.max` and `growth` bounds
//   `{ dimension, bound: "constant" | "linear" }` relative to exactly one named dimension.
// - Evidence `coding-tooling/work-evidence/v1`: suite, sha256 of the contract bytes, and per
//   operation one sample per declared scale point with every declared metric.
// - `workComplexityEvidence(root, { evidence? })` from `src/work-complexity.ts` invokes the root
//   component's `performance:work` capability (stdout = evidence JSON), or reads `evidence`
//   when given, and returns a `coding-tooling/work-complexity/v1` result envelope.
// - CLI: `coding-tooling performance work --root <dir> [--evidence <file>] --json`.
// - `performance applicability` gains the `work-complexity` family (capability `performance:work`).
//
// Growth semantics (deterministic, no curve fitting): within each group of scale points that agree
// on every other dimension, ordered by the bounded dimension from its smallest value x0:
// constant  => value(x) <= value(x0);
// linear    => value(x) * x0 <= value(x0) * x  (proportional growth, including a fixed overhead).
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { analyzeExpectations } from "../src/expectations.ts";
import { performanceApplicability } from "../src/performance-applicability.ts";
import { workComplexityEvidence } from "../src/work-complexity.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Sample = { dimensions: Record<string, number>; metrics: Record<string, number> };

const SCALE = [1_000, 10_000, 100_000];

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "camera-pan",
    description: "Pan the camera over unchanged static features.",
    dimensions: { features: { description: "static features loaded" } },
    scalePoints: SCALE.map((features) => ({ features })),
    metrics: [
      {
        name: "geometry_uploads",
        unit: "uploads",
        signal: "operation-count",
        growth: [{ dimension: "features", bound: "constant" }],
      },
      {
        name: "features_visited",
        unit: "features",
        signal: "operation-count",
        growth: [{ dimension: "features", bound: "linear" }],
      },
    ],
    ...overrides,
  };
}

function contract(operations: unknown[] = [operation()], schemaVersion = 2) {
  return {
    schemaVersion,
    suite: "fixture/work",
    scenarios: [
      {
        id: "common-work",
        kind: "common",
        description: "Representative deterministic fixture",
        dimensions: { features: 1000 },
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
    ...(schemaVersion >= 2 ? { operations } : {}),
  };
}

function fixture(declared: unknown = contract()): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-work-complexity-"));
  roots.push(root);
  mkdirSync(join(root, ".performance"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(join(root, ".performance/contract.json"), `${JSON.stringify(declared, null, 2)}\n`);
  // The repository-owned collector replays a recorded evidence file to stdout.
  writeFileSync(
    join(root, "scripts/work.ts"),
    'process.stdout.write(require("node:fs").readFileSync("evidence.json", "utf8"));\n',
  );
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capabilityCommands: { ".": { "performance:work": [process.execPath, "scripts/work.ts"] } },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function contractSha256(root: string): string {
  return createHash("sha256")
    .update(readFileSync(join(root, ".performance/contract.json")))
    .digest("hex");
}

function samples(
  values: (features: number) => Record<string, number>,
  points: number[] = SCALE,
): Sample[] {
  return points.map((features) => ({ dimensions: { features }, metrics: values(features) }));
}

function evidence(
  root: string,
  operations: { id: string; samples: Sample[] }[],
  overrides: Record<string, unknown> = {},
) {
  const value = {
    schemaVersion: "coding-tooling/work-evidence/v1",
    suite: "fixture/work",
    contractSha256: contractSha256(root),
    operations,
    ...overrides,
  };
  writeFileSync(join(root, "evidence.json"), `${JSON.stringify(value, null, 2)}\n`);
  return join(root, "evidence.json");
}

const stable = (features: number) => ({ geometry_uploads: 3, features_visited: features });

function checks(report: ReturnType<typeof workComplexityEvidence>, id = "camera-pan") {
  return report.data.operations.find((value) => value.id === id)?.checks ?? [];
}

function check(
  report: ReturnType<typeof workComplexityEvidence>,
  metric: string,
  kind: "growth" | "budget",
  dimension?: string,
) {
  return checks(report).find(
    (value) =>
      value.metric === metric &&
      value.kind === kind &&
      (dimension === undefined || value.dimension === dimension),
  );
}

describe("work complexity contracts", () => {
  test("a constant contract passes stable counters across 1k/10k/100k scale points", () => {
    const root = fixture();
    evidence(root, [{ id: "camera-pan", samples: samples(stable) }]);

    const report = workComplexityEvidence(root);

    expect(report.status).toBe("passed");
    expect(report.data.schemaVersion).toBe("coding-tooling/work-complexity/v1");
    expect(report.data.contractSha256).toBe(contractSha256(root));
    expect(check(report, "geometry_uploads", "growth", "features")).toMatchObject({
      bound: "constant",
      state: "passed",
    });
    expect(check(report, "features_visited", "growth", "features")).toMatchObject({
      bound: "linear",
      state: "passed",
    });
  });

  test("a constant contract fails when work grows with N", () => {
    const root = fixture();
    evidence(root, [
      {
        id: "camera-pan",
        samples: samples((features) => ({
          geometry_uploads: features / 1000,
          features_visited: features,
        })),
      },
    ]);

    const report = workComplexityEvidence(root);

    expect(report.status).toBe("failed");
    expect(check(report, "geometry_uploads", "growth", "features")?.state).toBe("failed");
    expect(check(report, "features_visited", "growth", "features")?.state).toBe("passed");
  });

  test("even one extra unit of growth over the smallest scale point breaks a constant bound", () => {
    const root = fixture();
    evidence(root, [
      {
        id: "camera-pan",
        samples: samples((features) => ({
          geometry_uploads: features === 100_000 ? 4 : 3,
          features_visited: features,
        })),
      },
    ]);
    expect(workComplexityEvidence(root).status).toBe("failed");
  });

  test("a linear contract accepts proportional work with a fixed overhead", () => {
    const root = fixture();
    evidence(root, [
      {
        id: "camera-pan",
        samples: samples((features) => ({
          geometry_uploads: 3,
          features_visited: 2 * features + 7,
        })),
      },
    ]);
    const report = workComplexityEvidence(root);
    expect(report.status).toBe("passed");
    expect(check(report, "features_visited", "growth", "features")?.state).toBe("passed");
  });

  test("a linear contract rejects superlinear evidence", () => {
    for (const superlinear of [
      (features: number) => Math.round(features * Math.log2(features)),
      (features: number) => features * features,
    ]) {
      const root = fixture();
      evidence(root, [
        {
          id: "camera-pan",
          samples: samples((features) => ({
            geometry_uploads: 3,
            features_visited: superlinear(features),
          })),
        },
      ]);
      const report = workComplexityEvidence(root);
      expect(report.status).toBe("failed");
      expect(check(report, "features_visited", "growth", "features")?.state).toBe("failed");
    }
  });

  test("absolute budgets and growth bounds coexist and are reported separately", () => {
    const declared = contract([
      operation({
        metrics: [
          {
            name: "geometry_uploads",
            unit: "uploads",
            signal: "operation-count",
            budget: { max: 2 },
            growth: [{ dimension: "features", bound: "constant" }],
          },
        ],
      }),
    ]);
    const root = fixture(declared);
    evidence(root, [{ id: "camera-pan", samples: samples(() => ({ geometry_uploads: 3 })) }]);

    const report = workComplexityEvidence(root);

    expect(report.status).toBe("failed");
    expect(check(report, "geometry_uploads", "growth", "features")?.state).toBe("passed");
    expect(check(report, "geometry_uploads", "budget")?.state).toBe("failed");

    evidence(root, [{ id: "camera-pan", samples: samples(() => ({ geometry_uploads: 2 })) }]);
    const within = workComplexityEvidence(root);
    expect(within.status).toBe("passed");
    expect(check(within, "geometry_uploads", "budget")?.state).toBe("passed");
  });

  test("multi-dimensional bounds are evaluated relative to exactly the named dimension", () => {
    // Integrating a moving subset: work may be linear in matching rows but constant in total rows.
    const declared = contract([
      {
        id: "integrate-subset",
        description: "Integrate entities matching Position+Velocity.",
        dimensions: { entities: {}, matching: {} },
        scalePoints: [
          { entities: 1_000, matching: 100 },
          { entities: 10_000, matching: 100 },
          { entities: 100_000, matching: 100 },
          { entities: 100_000, matching: 1_000 },
          { entities: 100_000, matching: 10_000 },
        ],
        metrics: [
          {
            name: "rows_scanned",
            unit: "rows",
            signal: "operation-count",
            growth: [
              { dimension: "entities", bound: "constant" },
              { dimension: "matching", bound: "linear" },
            ],
          },
        ],
      },
    ]);
    const run = (rows: (entities: number, matching: number) => number) => {
      const root = fixture(declared);
      const points: [number, number][] = [
        [1_000, 100],
        [10_000, 100],
        [100_000, 100],
        [100_000, 1_000],
        [100_000, 10_000],
      ];
      evidence(root, [
        {
          id: "integrate-subset",
          samples: points.map(([entities, matching]) => ({
            dimensions: { entities, matching },
            metrics: { rows_scanned: rows(entities, matching) },
          })),
        },
      ]);
      const report = workComplexityEvidence(root);
      const find = (dimension: string) =>
        report.data.operations[0]?.checks.find(
          (value) => value.kind === "growth" && value.dimension === dimension,
        );
      return { report, entities: find("entities"), matching: find("matching") };
    };

    const scansMatching = run((_entities, matching) => matching);
    expect(scansMatching.report.status).toBe("passed");
    expect(scansMatching.entities?.state).toBe("passed");
    expect(scansMatching.matching?.state).toBe("passed");

    // Regressing to a total-entity scan violates the entities bound, and only that bound.
    const scansEverything = run((entities) => entities);
    expect(scansEverything.report.status).toBe("failed");
    expect(scansEverything.entities?.state).toBe("failed");
    expect(scansEverything.matching?.state).toBe("passed");
  });

  test("a growth bound naming an undeclared dimension or an unknown growth class is refused", () => {
    for (const growth of [
      [{ dimension: "pixels", bound: "constant" }],
      [{ dimension: "features", bound: "quadratic" }],
    ]) {
      const declared = contract([
        operation({
          metrics: [
            { name: "geometry_uploads", unit: "uploads", signal: "operation-count", growth },
          ],
        }),
      ]);
      const root = fixture(declared);
      evidence(root, [{ id: "camera-pan", samples: samples(() => ({ geometry_uploads: 3 })) }]);
      const report = workComplexityEvidence(root);
      expect(report.status).not.toBe("passed");
      expect(report.diagnostics.length).toBeGreaterThan(0);
    }
  });

  describe("fails closed on unusable evidence", () => {
    const cases: [string, (root: string) => void][] = [
      ["malformed JSON", (root) => writeFileSync(join(root, "evidence.json"), "{ not json")],
      [
        "wrong evidence schema version",
        (root) =>
          evidence(root, [{ id: "camera-pan", samples: samples(stable) }], {
            schemaVersion: "coding-tooling/work-evidence/v0",
          }),
      ],
      [
        "stale contract hash",
        (root) =>
          evidence(root, [{ id: "camera-pan", samples: samples(stable) }], {
            contractSha256: "0".repeat(64),
          }),
      ],
      [
        "mismatched suite",
        (root) =>
          evidence(root, [{ id: "camera-pan", samples: samples(stable) }], {
            suite: "other/work",
          }),
      ],
      ["missing operation", (root) => evidence(root, [])],
      [
        "unknown operation only",
        (root) => evidence(root, [{ id: "zoom", samples: samples(stable) }]),
      ],
      [
        "missing scale point",
        (root) => evidence(root, [{ id: "camera-pan", samples: samples(stable, [1_000, 10_000]) }]),
      ],
      [
        "undeclared scale point",
        (root) =>
          evidence(root, [
            { id: "camera-pan", samples: samples(stable, [1_000, 10_000, 100_000, 50_000]) },
          ]),
      ],
      [
        "missing metric is not zero",
        (root) =>
          evidence(root, [
            {
              id: "camera-pan",
              samples: samples((features) => ({ features_visited: features })),
            },
          ]),
      ],
      [
        "non-numeric metric",
        (root) =>
          evidence(root, [
            {
              id: "camera-pan",
              samples: SCALE.map((features) => ({
                dimensions: { features },
                metrics: { geometry_uploads: "3", features_visited: features } as never,
              })),
            },
          ]),
      ],
      [
        "negative metric",
        (root) =>
          evidence(root, [
            {
              id: "camera-pan",
              samples: samples((features) => ({
                geometry_uploads: -1,
                features_visited: features,
              })),
            },
          ]),
      ],
    ];
    for (const [name, write] of cases) {
      test(name, () => {
        const root = fixture();
        write(root);
        const report = workComplexityEvidence(root);
        expect(report.status).toBe("unavailable");
        expect(report.diagnostics.length).toBeGreaterThan(0);
      });
    }

    test("a failing or silent collector is unavailable, not passed", () => {
      const root = fixture();
      writeFileSync(join(root, "scripts/work.ts"), "process.exit(3);\n");
      expect(workComplexityEvidence(root).status).toBe("unavailable");
      writeFileSync(join(root, "scripts/work.ts"), "");
      expect(workComplexityEvidence(root).status).toBe("unavailable");
    });

    test("a repository without the performance:work capability is unavailable", () => {
      const root = fixture();
      writeFileSync(
        join(root, ".coding-tooling.json"),
        JSON.stringify({ schemaVersion: 1, capabilityCommands: { ".": {} } }),
      );
      evidence(root, [{ id: "camera-pan", samples: samples(stable) }]);
      expect(workComplexityEvidence(root).status).toBe("unavailable");
    });

    test("a contract without operations has nothing to verify and is unavailable", () => {
      const root = fixture(contract([], 1));
      evidence(root, [{ id: "camera-pan", samples: samples(stable) }]);
      expect(workComplexityEvidence(root).status).toBe("unavailable");
    });
  });

  test("an explicit evidence file is evaluated without invoking the collector", () => {
    const root = fixture();
    const path = evidence(root, [{ id: "camera-pan", samples: samples(stable) }]);
    writeFileSync(join(root, "scripts/work.ts"), "process.exit(9);\n");
    expect(workComplexityEvidence(root, { evidence: path }).status).toBe("passed");
  });

  test("the CLI emits a stable JSON envelope and maps status to the exit code", () => {
    const router = resolve(import.meta.dir, "../src/router.ts");
    const root = fixture();
    evidence(root, [{ id: "camera-pan", samples: samples(stable) }]);
    const passed = spawnSync(
      process.execPath,
      [router, "performance", "work", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    expect(passed.status).toBe(0);
    const envelope = JSON.parse(passed.stdout);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      operation: "work-complexity",
      status: "passed",
      data: { schemaVersion: "coding-tooling/work-complexity/v1", suite: "fixture/work" },
    });
    expect(envelope.data.operations[0].checks.length).toBe(2);

    evidence(root, [
      {
        id: "camera-pan",
        samples: samples((features) => ({
          geometry_uploads: features,
          features_visited: features,
        })),
      },
    ]);
    const failed = spawnSync(
      process.execPath,
      [router, "performance", "work", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).status).toBe("failed");

    const stale = evidence(root, [{ id: "camera-pan", samples: samples(stable) }], {
      contractSha256: "f".repeat(64),
    });
    const unavailable = spawnSync(
      process.execPath,
      [router, "performance", "work", "--root", root, "--evidence", stale, "--json"],
      { encoding: "utf8" },
    );
    expect(unavailable.status).toBe(2);
    expect(JSON.parse(unavailable.stdout).status).toBe("unavailable");
  });

  test("the CLI is deterministic apart from timing", () => {
    const router = resolve(import.meta.dir, "../src/router.ts");
    const root = fixture();
    evidence(root, [{ id: "camera-pan", samples: samples(stable) }]);
    const run = () => {
      const output = spawnSync(
        process.execPath,
        [router, "performance", "work", "--root", root, "--json"],
        { encoding: "utf8" },
      );
      const { durationMs: _ignored, ...rest } = JSON.parse(output.stdout);
      return rest;
    };
    expect(run()).toEqual(run());
  });
});

describe("v1 compatibility", () => {
  test("v1 and v2 contracts are both accepted as performance contracts", () => {
    for (const declared of [contract([], 1), contract()]) {
      const root = fixture(declared);
      writeFileSync(
        join(root, ".coding-tooling.json"),
        JSON.stringify({
          schemaVersion: 1,
          requiredCapabilities: ["benchmark:smoke"],
          capabilityCommands: {
            ".": {
              "benchmark:smoke": ["bash", "scripts/performance-smoke.sh"],
              "performance:work": [process.execPath, "scripts/work.ts"],
            },
          },
        }),
      );
      const contractFindings = analyzeExpectations(root).findings.filter(
        (finding) =>
          finding.expectationId === "benchmark-evidence" &&
          finding.requirement.key === "performance-contract",
      );
      expect(contractFindings).toEqual([]);
    }
  });
});

describe("work-complexity applicability family", () => {
  function family(root: string) {
    return performanceApplicability(root, {
      available: () => true,
    }).data.components[0]?.families.find((value) => value.family === "work-complexity");
  }
  function declare(root: string, tools: string[] = []) {
    writeFileSync(
      join(root, ".performance/applicability.json"),
      JSON.stringify({
        schemaVersion: 1,
        components: [
          {
            component: ".",
            scenarios: [
              {
                family: "work-complexity",
                capability: "performance:work",
                path: ".performance/contract.json",
                tools,
                platforms: [],
              },
            ],
          },
        ],
      }),
    );
  }

  test("declared operations with a wired capability are supported", () => {
    const root = fixture();
    declare(root);
    expect(family(root)?.state).toBe("supported");
  });

  test("declared operations without wiring are applicable-missing", () => {
    const root = fixture();
    expect(family(root)?.state).toBe("applicable-missing");
  });

  test("a repository without declared operations is not-applicable for the family", () => {
    const root = fixture(contract([], 1));
    expect(family(root)?.state).toBe("not-applicable");
  });

  test("missing declared tools are an unsupported environment", () => {
    const root = fixture();
    declare(root, ["work-collector-that-does-not-exist"]);
    const row = performanceApplicability(root).data.components[0]?.families.find(
      (value) => value.family === "work-complexity",
    );
    expect(row?.state).toBe("unsupported-environment");
  });
});
