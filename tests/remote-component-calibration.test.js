import { describe, expect, test } from "bun:test";
import { scoreCalibration } from "../src/calibration.ts";
import { analyzeSnapshot } from "../site/preflight.js";

function labeledSnapshot() {
  const files = {
    "package.json": JSON.stringify({ name: "root", packageManager: "bun@1.4.2" }),
    "packages/tested/package.json": JSON.stringify({
      name: "tested",
      scripts: { test: "bun test" },
    }),
    "packages/missing/package.json": JSON.stringify({
      name: "missing",
      scripts: { test: "bun test" },
    }),
    "rust/Cargo.toml": '[package]\nname="rust"\nversion="0.1.0"\n',
    "dotnet/App.csproj": "<Project />",
  };
  const paths = [
    ...Object.keys(files),
    "packages/tested/src/index.ts",
    "packages/tested/tests/index.test.ts",
    "packages/missing/src/index.ts",
    "rust/src/lib.rs",
    "dotnet/src/Program.cs",
    "dotnet/tests/AppTests.cs",
    "fixtures/example/package.json",
  ];
  return {
    repository: { name: "fixture", fullName: "example/fixture", defaultBranch: "main" },
    tree: paths.map((path) => ({ path, type: "blob", sha: path })),
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
  };
}

describe("labeled remote component structural calibration", () => {
  test("component boundaries preserve positive, negative and unknown labels", () => {
    const analysis = analyzeSnapshot(labeledSnapshot());
    expect(
      analysis.components.some((component) => component.path.startsWith("fixtures/")),
    ).toBeFalse();
    const rust = analysis.components.find((component) => component.kind === "rust");
    expect(["unsupported", "incomplete"]).toContain(rust.testEvidence.status);
    const labels = [
      { subject: "packages/tested", requirement: "test", expected: "satisfied" },
      { subject: "packages/missing", requirement: "test", expected: "finding" },
      { subject: "dotnet", requirement: "test", expected: "satisfied" },
      { subject: "rust", requirement: "test", expected: "unknown" },
    ];
    const observed = new Set(
      analysis.components
        .filter((component) => component.testEvidence.status === "finding")
        .map((component) => `${component.path}\0test`),
    );
    const result = scoreCalibration(labels, observed, new Map());
    expect(result.metrics).toEqual({
      truePositive: 1,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 2,
      unknown: 1,
      precision: 1,
      recall: 1,
    });
    expect(result.unlabeledFindings).toEqual([]);
    const mutation = scoreCalibration(labels, new Set(["packages/tested\0test"]), new Map());
    expect(mutation.metrics.falsePositive).toBe(1);
    expect(mutation.metrics.falseNegative).toBe(1);
  });
});
