// Implementation-owned regressions for #300 review findings; the acceptance file stays unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { performanceApplicability } from "../src/performance-applicability.ts";
import { performanceContractValidationError } from "../src/performance-contract.ts";
import { workComplexityEvidence } from "../src/work-complexity.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SCALE = [1_000, 10_000, 100_000];
const scenarios = [
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
      },
    ],
  },
];

function contract(metric: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    suite: "fixture/work",
    scenarios,
    operations: [
      {
        id: "camera-pan",
        description: "Pan the camera over unchanged static features.",
        dimensions: { features: {} },
        scalePoints: SCALE.map((features) => ({ features })),
        metrics: [metric],
      },
    ],
  };
}

const uploads = {
  name: "geometry_uploads",
  unit: "uploads",
  signal: "operation-count",
  growth: [{ dimension: "features", bound: "constant" }],
};

function fixture(declared: unknown, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-work-regression-"));
  roots.push(root);
  mkdirSync(join(root, ".performance"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, ".performance/contract.json"),
    typeof declared === "string" ? declared : `${JSON.stringify(declared, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "scripts/work.ts"),
    'process.stdout.write(require("node:fs").readFileSync("evidence.json", "utf8"));\n',
  );
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents);
  return root;
}

function writeEvidence(root: string, metrics: (features: number) => Record<string, number>) {
  const contractSha256 = createHash("sha256")
    .update(readFileSync(join(root, ".performance/contract.json")))
    .digest("hex");
  writeFileSync(
    join(root, "evidence.json"),
    JSON.stringify({
      schemaVersion: "coding-tooling/work-evidence/v1",
      suite: "fixture/work",
      contractSha256,
      operations: [
        {
          id: "camera-pan",
          samples: SCALE.map((features) => ({
            dimensions: { features },
            metrics: metrics(features),
          })),
        },
      ],
    }),
  );
  return join(root, "evidence.json");
}

describe("prototype-sensitive names", () => {
  test("a __proto__ metric cannot bypass its budget", () => {
    const root = fixture(
      contract({ name: "__proto__", unit: "uploads", signal: "size", budget: { max: 2 } }),
    );
    // JSON.parse creates an own "__proto__" key, exactly as a collector would emit it.
    const contractSha256 = createHash("sha256")
      .update(readFileSync(join(root, ".performance/contract.json")))
      .digest("hex");
    const samples = SCALE.map(
      (features) => `{"dimensions":{"features":${features}},"metrics":{"__proto__":99}}`,
    ).join(",");
    writeFileSync(
      join(root, "evidence.json"),
      `{"schemaVersion":"coding-tooling/work-evidence/v1","suite":"fixture/work","contractSha256":"${contractSha256}","operations":[{"id":"camera-pan","samples":[${samples}]}]}`,
    );
    const report = workComplexityEvidence(root, { evidence: join(root, "evidence.json") });
    expect(report.status).toBe("unavailable");
    expect(report.diagnostics[0]?.code).toBe("performance-contract-invalid");
  });

  test("constructor and prototype are reserved metric and dimension names", () => {
    for (const name of ["constructor", "prototype"])
      expect(performanceContractValidationError(contract({ ...uploads, name }))).toContain(
        "reserved",
      );
    const declared = contract(uploads);
    declared.operations[0]!.dimensions = { constructor: {} } as never;
    expect(performanceContractValidationError(declared)).toBeDefined();
  });
});

describe("operation metric notes", () => {
  test("notes must be a non-empty string like the schema requires", () => {
    for (const notes of [0, "", "  ", null])
      expect(performanceContractValidationError(contract({ ...uploads, notes }))).toContain(
        "notes must be a non-empty string",
      );
    expect(
      performanceContractValidationError(contract({ ...uploads, notes: "counted per frame" })),
    ).toBeUndefined();
  });
});

describe("polyglot repository roots", () => {
  const files = {
    "Cargo.toml": '[package]\nname = "native"\nversion = "0.1.0"\nedition = "2021"\n',
    "package.json": JSON.stringify({
      name: "zz-web",
      private: true,
      scripts: { "performance:work": "bun scripts/work.ts" },
    }),
    "bun.lock": "",
  };

  test("the collector comes from the root component that declares performance:work", () => {
    const root = fixture(contract(uploads), files);
    writeEvidence(root, () => ({ geometry_uploads: 3 }));
    const report = workComplexityEvidence(root);
    expect(report.diagnostics).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.data.evidence.command).toEqual(["bun", "run", "performance:work"]);

    const families = performanceApplicability(root, { available: () => true })
      .data.components.filter((component) => component.path === ".")
      .map((component) => [
        component.name,
        component.families.find((value) => value.family === "work-complexity")?.state,
      ]);
    expect(families).toContainEqual(["zz-web", "applicable-missing"]);
    expect(families).toContainEqual([basename(root), "not-applicable"]);
  });

  test("different root collector commands are an explicit ambiguity", () => {
    const root = fixture(contract(uploads), files);
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        capabilityCommands: {
          [basename(root)]: { "performance:work": [process.execPath, "scripts/work.ts"] },
        },
      }),
    );
    writeEvidence(root, () => ({ geometry_uploads: 3 }));
    const report = workComplexityEvidence(root);
    expect(report.status).toBe("unavailable");
    expect(report.diagnostics[0]?.code).toBe("work-collector-ambiguous");
  });
});

describe("applicability validates every existing contract", () => {
  const config = JSON.stringify({
    schemaVersion: 1,
    capabilityCommands: { ".": { "performance:work": [process.execPath, "scripts/work.ts"] } },
  });
  for (const [name, declared] of [
    ["a malformed v1 contract", { schemaVersion: 1, suite: "fixture/work" }],
    ["an unsupported contract version", { schemaVersion: 3, suite: "fixture/work", scenarios }],
    ["invalid JSON", "{ not json"],
  ] as const)
    test(`${name} is reported as performance-contract-invalid`, () => {
      const root = fixture(declared, { ".coding-tooling.json": config });
      const report = performanceApplicability(root, { available: () => true });
      expect(report.status).toBe("unavailable");
      expect(report.diagnostics.map((value) => value.code)).toContain(
        "performance-contract-invalid",
      );
    });

  test("a valid v1 contract stays clean and not applicable", () => {
    const root = fixture(
      { schemaVersion: 1, suite: "fixture/work", scenarios },
      { ".coding-tooling.json": config },
    );
    const report = performanceApplicability(root, { available: () => true });
    expect(report.diagnostics).toEqual([]);
    expect(
      report.data.components[0]?.families.find((value) => value.family === "work-complexity")
        ?.state,
    ).toBe("not-applicable");
  });
});
