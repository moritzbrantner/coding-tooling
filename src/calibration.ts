import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  analyzeExpectations,
  type ExpectationEnvelope,
  type Finding,
  type FindingDisposition,
} from "./expectations.ts";
import { walkFiles } from "./shared.ts";

export type CalibrationExpectation = "finding" | "satisfied" | "unknown";

export type CalibrationLabel = {
  subject: string;
  requirement: string;
  expected: CalibrationExpectation;
  disposition?: Exclude<FindingDisposition, "active">;
};

export type CalibrationCase = {
  schemaVersion: 1;
  id: string;
  detector: string;
  fixture: string;
  coverage?: "applied" | "not-applicable" | "unsupported" | "unavailable";
  labels: CalibrationLabel[];
};

export type CalibrationMetrics = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  unknown: number;
  precision: number | null;
  recall: number | null;
};

export type CalibrationCaseResult = {
  id: string;
  detector: string;
  fixture: string;
  coverage: string | undefined;
  expectedCoverage: string | undefined;
  metrics: CalibrationMetrics;
  unlabeledFindings: string[];
  dispositionMismatches: string[];
};

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

export function scoreCalibration(
  labels: readonly CalibrationLabel[],
  activeKeys: ReadonlySet<string>,
  allByKey: ReadonlyMap<string, Finding>,
): {
  metrics: CalibrationMetrics;
  unlabeledFindings: string[];
  dispositionMismatches: string[];
} {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let unknown = 0;
  const labeled = new Set<string>();
  const dispositionMismatches: string[] = [];

  for (const label of labels) {
    const key = `${label.subject}\0${label.requirement}`;
    if (labeled.has(key)) throw new Error(`duplicate calibration label ${key}`);
    labeled.add(key);
    const active = activeKeys.has(key);
    const finding = allByKey.get(key);

    if (label.expected === "unknown") {
      unknown += 1;
      continue;
    }
    if (label.expected === "finding") {
      if (active) truePositive += 1;
      else falseNegative += 1;
      continue;
    }

    if (active) falsePositive += 1;
    else trueNegative += 1;
    if (label.disposition && finding?.disposition !== label.disposition) {
      dispositionMismatches.push(
        `${label.subject} expected ${label.disposition} but observed ${finding?.disposition ?? "absent"}`,
      );
    }
  }

  const unlabeledFindings = [...activeKeys]
    .filter((key) => !labeled.has(key))
    .map((key) => key.replace("\0", " :: "))
    .sort();

  return {
    metrics: {
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      unknown,
      precision: ratio(truePositive, truePositive + falsePositive),
      recall: ratio(truePositive, truePositive + falseNegative),
    },
    unlabeledFindings,
    dispositionMismatches: dispositionMismatches.sort(),
  };
}

function findingKey(finding: Finding): string {
  return `${finding.subject.key}\0${finding.requirement.key}`;
}

function parseCase(path: string): CalibrationCase {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a calibration object`);
  }
  const candidate = value as Partial<CalibrationCase>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== "string" ||
    !candidate.id ||
    typeof candidate.detector !== "string" ||
    !candidate.detector ||
    typeof candidate.fixture !== "string" ||
    !candidate.fixture ||
    !Array.isArray(candidate.labels)
  ) {
    throw new Error(`${path} has an invalid calibration contract`);
  }
  for (const [index, label] of candidate.labels.entries()) {
    if (
      !label ||
      typeof label.subject !== "string" ||
      !label.subject ||
      typeof label.requirement !== "string" ||
      !label.requirement ||
      !["finding", "satisfied", "unknown"].includes(label.expected)
    ) {
      throw new Error(`${path} labels[${index}] is invalid`);
    }
    if (label.disposition && !["suppressed", "verified"].includes(label.disposition)) {
      throw new Error(`${path} labels[${index}].disposition is invalid`);
    }
  }
  return candidate as CalibrationCase;
}

function loadCases(root: string): CalibrationCase[] {
  const casesRoot = join(root, "calibration", "cases");
  return walkFiles(casesRoot, 2)
    .filter((path) => path.endsWith(".json"))
    .sort()
    .map(parseCase)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function aggregateMetrics(values: readonly CalibrationMetrics[]): CalibrationMetrics {
  const totals = values.reduce(
    (result, value) => ({
      truePositive: result.truePositive + value.truePositive,
      falsePositive: result.falsePositive + value.falsePositive,
      falseNegative: result.falseNegative + value.falseNegative,
      trueNegative: result.trueNegative + value.trueNegative,
      unknown: result.unknown + value.unknown,
    }),
    { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, unknown: 0 },
  );
  return {
    ...totals,
    precision: ratio(totals.truePositive, totals.truePositive + totals.falsePositive),
    recall: ratio(totals.truePositive, totals.truePositive + totals.falseNegative),
  };
}

function evaluateCase(root: string, calibration: CalibrationCase): CalibrationCaseResult {
  const fixtureRoot = resolve(root, calibration.fixture);
  const activeAnalysis = analyzeExpectations(fixtureRoot);
  const fullAnalysis = analyzeExpectations(fixtureRoot, { includeSuppressed: true });
  const activeFindings = activeAnalysis.findings.filter(
    (finding) => finding.expectationId === calibration.detector,
  );
  const allFindings = fullAnalysis.findings.filter(
    (finding) => finding.expectationId === calibration.detector,
  );
  const activeKeys = new Set(activeFindings.map(findingKey));
  const allByKey = new Map(allFindings.map((finding) => [findingKey(finding), finding]));
  const scored = scoreCalibration(calibration.labels, activeKeys, allByKey);
  const coverage = fullAnalysis.coverage.detectors.find(
    (detector) => detector.id === calibration.detector,
  )?.status;

  return {
    id: calibration.id,
    detector: calibration.detector,
    fixture: calibration.fixture,
    coverage,
    expectedCoverage: calibration.coverage,
    ...scored,
  };
}

export function calibrationCommand(root: string): ExpectationEnvelope {
  const started = Date.now();
  try {
    const cases = loadCases(root);
    const results = cases.map((calibration) => evaluateCase(root, calibration));
    const detectorNames = [...new Set(results.map((result) => result.detector))].sort();
    const detectors = detectorNames.map((detector) => ({
      detector,
      metrics: aggregateMetrics(
        results.filter((result) => result.detector === detector).map((result) => result.metrics),
      ),
    }));
    const metrics = aggregateMetrics(results.map((result) => result.metrics));
    const failedCases = results
      .filter(
        (result) =>
          result.metrics.falsePositive > 0 ||
          result.metrics.falseNegative > 0 ||
          result.unlabeledFindings.length > 0 ||
          result.dispositionMismatches.length > 0 ||
          (result.expectedCoverage !== undefined && result.coverage !== result.expectedCoverage),
      )
      .map((result) => result.id);

    return {
      schemaVersion: 1,
      operation: "calibration",
      status: failedCases.length === 0 ? "passed" : "failed",
      durationMs: Date.now() - started,
      data: {
        root,
        caseCount: cases.length,
        metrics,
        detectors,
        cases: results,
        failedCases,
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "calibration",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, caseCount: 0, source: basename(join(root, "calibration", "cases")) },
      diagnostics: [
        {
          code: "calibration-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
