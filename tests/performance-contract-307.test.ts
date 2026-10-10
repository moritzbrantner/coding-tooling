// Acceptance for #307 (follow-ups from the #306 review):
// 1. With several components at ".", an applicability declaration selected by `component: "."`
//    must not make non-collector roots report `work-complexity` as applicable-missing; only the
//    root that declares `performance:work` carries the family.
// 2. The published contract schema and the shared parser agree on whitespace-only strings: the
//    parser's rule (must contain a non-space character) is authoritative, so the schema's
//    `suite`, scenario `description` and metric `name`/`unit` require a non-space character.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { performanceApplicability } from "../src/performance-applicability.ts";
import { performanceContractValidationError } from "../src/performance-contract.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scenarios = [
  {
    id: "common-work",
    kind: "common",
    description: "Representative deterministic fixture",
    dimensions: { features: 1000 },
    metrics: [
      {
        name: "visits",
        unit: "visits",
        direction: "lower",
        signal: "operation-count",
        blocking: true,
      },
    ],
  },
];

const v2 = {
  schemaVersion: 2,
  suite: "fixture/work",
  scenarios,
  operations: [
    {
      id: "camera-pan",
      description: "Pan the camera.",
      dimensions: { features: {} },
      scalePoints: [{ features: 1000 }, { features: 10000 }],
      metrics: [
        {
          name: "uploads",
          unit: "uploads",
          signal: "operation-count",
          growth: [{ dimension: "features", bound: "constant" }],
        },
      ],
    },
  ],
};

function polyglot(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-307-"));
  roots.push(root);
  mkdirSync(join(root, ".performance"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".performance/contract.json"), JSON.stringify(v2));
  writeFileSync(join(root, "scripts/work.ts"), "process.stdout.write('{}');\n");
  writeFileSync(join(root, "src/lib.rs"), "pub fn f() {}\n");
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "native"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "zz-web",
      private: true,
      scripts: { "performance:work": "bun scripts/work.ts" },
    }),
  );
  writeFileSync(join(root, "bun.lock"), "");
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
              tools: [],
              platforms: [],
            },
          ],
        },
      ],
    }),
  );
  return root;
}

describe("work-complexity applicability with several root components (#307)", () => {
  test("only the collector root carries the family under a '.' declaration", () => {
    const root = polyglot();
    const report = performanceApplicability(root, { available: () => true });
    const states = report.data.components
      .filter((component) => component.path === ".")
      .map((component) => [
        component.name,
        component.families.find((value) => value.family === "work-complexity")?.state,
      ]);
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states).toContainEqual(["zz-web", "supported"]);
    for (const [name, state] of states) {
      if (name !== "zz-web") expect(state, `${name}`).toBe("not-applicable");
    }
    expect(basename(root)).toBeTruthy();
  });
});

describe("schema and parser agree on whitespace-only strings (#307)", () => {
  const schema = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../schemas/performance-contract.schema.json"), "utf8"),
  );
  const requiresNonSpace = (property: { pattern?: string } | undefined) =>
    typeof property?.pattern === "string" &&
    new RegExp(property.pattern).test("a") &&
    !new RegExp(property.pattern).test("   ");

  test("the schema requires a non-space character where the parser does", () => {
    const scenario = schema.properties.scenarios.items.properties;
    const metric = scenario.metrics.items.properties;
    expect(requiresNonSpace(schema.properties.suite)).toBe(true);
    expect(requiresNonSpace(scenario.description)).toBe(true);
    expect(requiresNonSpace(metric.name)).toBe(true);
    expect(requiresNonSpace(metric.unit)).toBe(true);
  });

  test("the parser rejects the same whitespace-only values", () => {
    const base = { schemaVersion: 1, suite: "fixture/work", scenarios };
    expect(performanceContractValidationError(base)).toBeUndefined();
    expect(performanceContractValidationError({ ...base, suite: "   " })).toBeDefined();
    expect(
      performanceContractValidationError({
        ...base,
        scenarios: [{ ...scenarios[0], description: "  " }],
      }),
    ).toBeDefined();
    expect(
      performanceContractValidationError({
        ...base,
        scenarios: [{ ...scenarios[0], metrics: [{ ...scenarios[0]!.metrics[0], unit: " " }] }],
      }),
    ).toBeDefined();
  });
});
