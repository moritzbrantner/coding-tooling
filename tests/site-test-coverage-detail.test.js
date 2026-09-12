import { describe, expect, test } from "bun:test";

import { buildTestCoverageDetailSnapshot } from "../scripts/build-test-coverage-detail-snapshot.js";
import { parseCoverageDetail } from "../site/test-coverage-detail.js";

const revision = "1111111111111111111111111111111111111111";

describe("detailed test coverage publication", () => {
  test("normalizes deterministic per-file LCOV line, function, and branch evidence", () => {
    const files = parseCoverageDetail(sampleLcov(), "lcov");

    expect(files).toEqual([
      {
        path: "src/alpha.js",
        lines: [{ line: 4, hits: 2, covered: true }],
        functions: [{ name: "alpha", line: 4, hits: 2, covered: true }],
        branches: [],
      },
      {
        path: "src/zeta.js",
        lines: [
          { line: 1, hits: 1, covered: true },
          { line: 2, hits: 3, covered: true },
          { line: 5, hits: 0, covered: false },
        ],
        functions: [
          { name: "covered", line: 2, hits: 3, covered: true },
          { name: "uncovered", line: 5, hits: 0, covered: false },
        ],
        branches: [
          { line: 2, block: "0", branch: "0", hits: 3, covered: true },
          { line: 2, block: "0", branch: "1", hits: null, covered: false },
        ],
      },
    ]);
  });

  test("builds a suite-level exact-revision artifact without inventing attribution", () => {
    const files = parseCoverageDetail(sampleLcov(), "lcov");
    const snapshot = buildTestCoverageDetailSnapshot({
      files,
      repository: "example/repo",
      revision,
      generatedAt: "2026-09-12T11:30:00Z",
      sourcePath: "coverage/lcov.info",
      sourceFormat: "lcov",
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      kind: "coding-tooling-test-coverage-detail",
      repository: { fullName: "example/repo", revision },
      generatedAt: "2026-09-12T11:30:00.000Z",
      producer: { id: "coding-tooling", protocolVersion: 1 },
      source: { path: "coverage/lcov.info", format: "lcov" },
      granularity: "suite",
      files,
    });
    expect(snapshot).not.toHaveProperty("tests");
    expect(snapshot).not.toHaveProperty("contracts");
    expect(snapshot).not.toHaveProperty("threshold");
  });

  test("fails closed for unsupported detail formats and invalid revisions", () => {
    expect(() => parseCoverageDetail("{}", "istanbul-summary")).toThrow(
      "Unsupported detailed coverage format",
    );

    expect(() =>
      buildTestCoverageDetailSnapshot({
        files: [],
        repository: "example/repo",
        revision: "main",
        generatedAt: "2026-09-12T11:30:00Z",
        sourcePath: "coverage/lcov.info",
        sourceFormat: "lcov",
      }),
    ).toThrow("exact Git commit SHA");
  });
});

function sampleLcov() {
  return [
    "TN:",
    "SF:src/zeta.js",
    "FN:2,covered",
    "FN:5,uncovered",
    "FNDA:3,covered",
    "FNDA:0,uncovered",
    "DA:1,1",
    "DA:2,3",
    "DA:5,0",
    "BRDA:2,0,0,3",
    "BRDA:2,0,1,-",
    "end_of_record",
    "SF:src/alpha.js",
    "FN:4,alpha",
    "FNDA:2,alpha",
    "DA:4,2",
    "end_of_record",
  ].join("\n");
}
