import { describe, expect, test } from "bun:test";

import { calibrationCommand, scoreCalibration, type CalibrationLabel } from "../src/calibration.ts";
import { repositoryRoot } from "../src/shared.ts";

describe("detector calibration", () => {
  test("measures deliberate false-positive and false-negative mutations", () => {
    const labels: CalibrationLabel[] = [
      { subject: "src/missing.ts", requirement: "test", expected: "finding" },
      { subject: "src/clean.ts", requirement: "test", expected: "satisfied" },
      { subject: "src/ambiguous.ts", requirement: "test", expected: "unknown" },
    ];
    const result = scoreCalibration(labels, new Set(["src/clean.ts\0test"]), new Map());

    expect(result.metrics).toEqual({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 0,
      unknown: 1,
      precision: 0,
      recall: 0,
    });
  });

  test("does not silently classify unlabeled findings as true negatives", () => {
    const result = scoreCalibration(
      [{ subject: "src/known.ts", requirement: "test", expected: "satisfied" }],
      new Set(["src/unlabeled.ts\0test"]),
      new Map(),
    );

    expect(result.metrics.trueNegative).toBe(1);
    expect(result.unlabeledFindings).toEqual(["src/unlabeled.ts :: test"]);
  });

  test("repository-owned labeled corpus passes without known precision or recall regressions", () => {
    const result = calibrationCommand(repositoryRoot());

    expect(result.status).toBe("passed");
    expect(result.data.failedCases).toEqual([]);
    expect(result.data.caseCount).toBe(10);
    expect(result.data.metrics).toEqual({
      truePositive: 5,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 8,
      unknown: 1,
      precision: 1,
      recall: 1,
    });
  });
});
