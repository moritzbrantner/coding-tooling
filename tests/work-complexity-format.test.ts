import { expect, test } from "bun:test";

import { formatWorkComplexity, type WorkComplexityData } from "../src/work-complexity.ts";

test("work complexity prints one aligned row per check with failures counted", () => {
  const data: WorkComplexityData = {
    schemaVersion: "coding-tooling/work-complexity/v1",
    root: "/repo",
    contract: { path: ".performance/contract.json", schemaVersion: 2 },
    suite: "engine",
    contractSha256: null,
    evidence: { source: "file", command: null, path: "evidence.json", sha256: null },
    operations: [
      {
        id: "ray",
        description: "",
        publicContract: null,
        dimensions: ["bodies", "hits"],
        scalePoints: 4,
        checks: [
          {
            metric: "nodes",
            kind: "growth",
            dimension: "bodies",
            bound: "logarithmic",
            state: "passed",
            violations: [],
          },
          {
            metric: "nodes",
            kind: "growth",
            product: [
              { dimension: "hits", bound: "linear", degree: 1, logDegree: 0 },
              { dimension: "bodies", bound: "logarithmic", degree: 0, logDegree: 1 },
            ],
            state: "failed",
            violations: [{ point: { bodies: 8, hits: 2 }, value: 99 }],
          },
          { metric: "allocs", kind: "budget", max: 0, state: "passed", violations: [] },
        ],
      },
    ],
    limitations: [],
  };

  expect(formatWorkComplexity(data).split("\n")).toEqual([
    "Work complexity in /repo (suite engine): 1 operations, 3 checks, 1 failed.",
    "operation  metric  kind    dimension    bound                               state",
    "ray        nodes   growth  bodies       logarithmic                         passed",
    "ray        nodes   growth  hits,bodies  linear(hits) * logarithmic(bodies)  FAILED (1 violations)",
    "ray        allocs  budget               <= 0                                passed",
  ]);
});
