import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import {
  analyzeExpectations,
  type ExpectationEnvelope,
  type Finding,
  type FindingDisposition,
} from "./expectations.ts";
import { commandAvailable, runCommand, walkFiles } from "./shared.ts";

export type CalibrationExpectation = "finding" | "satisfied" | "unknown";
export type CalibrationEnvelope = Omit<ExpectationEnvelope, "operation"> & {
  operation: "calibration";
};

export type CalibrationLabel = {
  subject: string;
  requirement: string;
  expected: CalibrationExpectation;
  disposition?: Exclude<FindingDisposition, "active">;
};

export type CalibrationPreparation = {
  kind: "dotnet-restore";
  project: string;
};

export type CalibrationCase = {
  schemaVersion: 1;
  id: string;
  detector: string;
  fixture: string;
  preparation?: CalibrationPreparation;
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
  preparation?: CalibrationPreparation;
  preparationStatus?: "applied" | "unavailable";
  unavailableReason?: string;
  coverage: string | undefined;
  expectedCoverage: string | undefined;
  metrics: CalibrationMetrics;
  unlabeledFindings: string[];
  dispositionMismatches: string[];
};

type PreparedFixture = {
  root: string;
  preparationStatus?: "applied" | "unavailable";
  unavailableReason?: string;
  cleanup(): void;
};

const emptyMetrics: CalibrationMetrics = {
  truePositive: 0,
  falsePositive: 0,
  falseNegative: 0,
  trueNegative: 0,
  unknown: 0,
  precision: null,
  recall: null,
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

function preparation(value: unknown, path: string): CalibrationPreparation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} preparation is invalid`);
  }
  const candidate = value as Partial<CalibrationPreparation>;
  if (
    candidate.kind !== "dotnet-restore" ||
    typeof candidate.project !== "string" ||
    !candidate.project
  ) {
    throw new Error(`${path} preparation is invalid`);
  }
  if (isAbsolute(candidate.project) || candidate.project.split(/[\\/]/).includes("..")) {
    throw new Error(`${path} preparation project must stay inside the fixture`);
  }
  return candidate as CalibrationPreparation;
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
  return {
    ...(candidate as CalibrationCase),
    preparation: preparation(candidate.preparation, path),
  };
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

function isWithin(root: string, path: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

function prepareFixture(sourceRoot: string, calibration: CalibrationCase): PreparedFixture {
  if (!calibration.preparation) {
    return { root: sourceRoot, cleanup() {} };
  }

  const temporaryParent = mkdtempSync(join(tmpdir(), "coding-tooling-calibration-"));
  const temporaryRoot = join(temporaryParent, "fixture");
  cpSync(sourceRoot, temporaryRoot, { recursive: true });

  const cleanup = () => rmSync(temporaryParent, { recursive: true, force: true });
  const project = resolve(temporaryRoot, calibration.preparation.project);
  if (!isWithin(temporaryRoot, project) || !existsSync(project)) {
    cleanup();
    throw new Error(
      `${calibration.id} preparation project does not exist: ${calibration.preparation.project}`,
    );
  }
  if (!commandAvailable("dotnet")) {
    return {
      root: temporaryRoot,
      preparationStatus: "unavailable",
      unavailableReason: "dotnet SDK is unavailable for calibration preparation",
      cleanup,
    };
  }

  const result = runCommand(
    "dotnet",
    ["restore", project, "--ignore-failed-sources", "--nologo", "--property:NuGetAudit=false"],
    temporaryRoot,
  );
  if (result.status !== 0) {
    const detail = [result.error, result.stderr.trim(), result.stdout.trim()].find(Boolean);
    return {
      root: temporaryRoot,
      preparationStatus: "unavailable",
      unavailableReason: detail ?? "dotnet restore preparation failed",
      cleanup,
    };
  }

  return { root: temporaryRoot, preparationStatus: "applied", cleanup };
}

function unavailableCase(calibration: CalibrationCase, reason: string): CalibrationCaseResult {
  return {
    id: calibration.id,
    detector: calibration.detector,
    fixture: calibration.fixture,
    preparation: calibration.preparation,
    preparationStatus: "unavailable",
    unavailableReason: reason,
    coverage: undefined,
    expectedCoverage: calibration.coverage,
    metrics: { ...emptyMetrics },
    unlabeledFindings: [],
    dispositionMismatches: [],
  };
}

function evaluateCase(root: string, calibration: CalibrationCase): CalibrationCaseResult {
  const fixtureSource = resolve(root, calibration.fixture);
  const prepared = prepareFixture(fixtureSource, calibration);
  try {
    if (prepared.unavailableReason) {
      return unavailableCase(calibration, prepared.unavailableReason);
    }

    const fullAnalysis = analyzeExpectations(prepared.root, { includeSuppressed: true });
    const allFindings = fullAnalysis.findings.filter(
      (finding) => finding.expectationId === calibration.detector,
    );
    const activeFindings = allFindings.filter((finding) => finding.disposition === "active");
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
      preparation: calibration.preparation,
      preparationStatus: prepared.preparationStatus,
      coverage,
      expectedCoverage: calibration.coverage,
      ...scored,
    };
  } finally {
    prepared.cleanup();
  }
}

export function calibrationCommand(root: string): CalibrationEnvelope {
  const started = Date.now();
  try {
    const cases = loadCases(root);
    const results = cases.map((calibration) => evaluateCase(root, calibration));
    const availableResults = results.filter((result) => !result.unavailableReason);
    const detectorNames = [...new Set(availableResults.map((result) => result.detector))].sort();
    const detectors = detectorNames.map((detector) => ({
      detector,
      metrics: aggregateMetrics(
        availableResults
          .filter((result) => result.detector === detector)
          .map((result) => result.metrics),
      ),
    }));
    const metrics = aggregateMetrics(availableResults.map((result) => result.metrics));
    const unavailableCases = results
      .filter((result) => result.unavailableReason)
      .map((result) => result.id);
    const failedCases = availableResults
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
      status:
        failedCases.length > 0 ? "failed" : unavailableCases.length > 0 ? "unavailable" : "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        caseCount: cases.length,
        metrics,
        detectors,
        cases: results,
        failedCases,
        unavailableCases,
      },
      diagnostics: unavailableCases.map((id) => ({
        code: "calibration-case-unavailable",
        message: `${id} could not be prepared in this environment`,
      })),
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
