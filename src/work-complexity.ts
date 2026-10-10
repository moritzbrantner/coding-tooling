import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declaredComponents, loadConfig } from "./core.ts";
import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  type GrowthBound,
  parsePerformanceContract,
  performanceContractPath,
  scaleKey,
  type WorkOperation,
} from "./performance-contract.ts";

export const workEvidenceSchemaVersion = "coding-tooling/work-evidence/v1";
const capability = "performance:work";
const collectorTimeoutMs = 10 * 60 * 1000;
const collectorMaxBuffer = 64 * 1024 * 1024;

type Point = Record<string, number>;
type Sample = { dimensions: Point; metrics: Record<string, number> };
type Violation = {
  point: Point;
  value: number;
  /** The smallest point of the group for a growth bound; absent for a budget. */
  baseline?: Point;
  baselineValue?: number;
};
export type WorkCheck = {
  metric: string;
  kind: "growth" | "budget";
  dimension?: string;
  bound?: GrowthBound;
  max?: number;
  state: "passed" | "failed";
  violations: Violation[];
};
type OperationResult = {
  id: string;
  description: string;
  publicContract: string | null;
  dimensions: string[];
  scalePoints: number;
  checks: WorkCheck[];
};
export type WorkComplexityData = {
  schemaVersion: "coding-tooling/work-complexity/v1";
  root: string;
  contract: { path: string; schemaVersion: 1 | 2 | null };
  suite: string | null;
  contractSha256: string | null;
  evidence: {
    source: "capability" | "file" | null;
    command: string[] | null;
    path: string | null;
    sha256: string | null;
  };
  operations: OperationResult[];
  limitations: string[];
};

class Unavailable extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function only(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new Unavailable(`${where} has unknown field ${unknown}.`, "work-evidence-invalid");
}

function collect(root: string, data: WorkComplexityData): string {
  const component = declaredComponents(root, loadConfig(root)).find((value) => value.path === ".");
  const command = component?.capabilities[capability];
  if (!command?.length)
    throw new Unavailable(
      `The root component declares no ${capability} capability command.`,
      "work-collector-unavailable",
      ".coding-tooling.json",
    );
  data.evidence.source = "capability";
  data.evidence.command = command;
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: collectorTimeoutMs,
    maxBuffer: collectorMaxBuffer,
  });
  if (result.error || result.signal || result.status !== 0) {
    const reason =
      result.error?.message ??
      (result.signal ? `terminated by ${result.signal}` : `exited with status ${result.status}`);
    const stderr = (result.stderr ?? "").trim().slice(-2000);
    throw new Unavailable(
      `The ${capability} collector did not complete: ${reason}.${stderr ? ` stderr: ${stderr}` : ""}`,
      "work-collector-failed",
    );
  }
  if (!result.stdout.trim())
    throw new Unavailable(
      `The ${capability} collector wrote no evidence to stdout.`,
      "work-collector-silent",
    );
  return result.stdout;
}

function readEvidenceFile(root: string, path: string, data: WorkComplexityData): string {
  const absolute = resolve(root, path);
  data.evidence.source = "file";
  data.evidence.path = absolute;
  if (!existsSync(absolute))
    throw new Unavailable(`Work evidence file is missing: ${path}`, "work-evidence-missing", path);
  return readFileSync(absolute, "utf8");
}

/** Parse and match the evidence against the contract; anything incomplete is unavailable. */
function parseEvidence(
  text: string,
  suite: string,
  contractSha256: string,
  operations: WorkOperation[],
): Map<string, Map<string, Sample>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Unavailable(
      `Work evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "work-evidence-invalid",
    );
  }
  if (!record(value) || value.schemaVersion !== workEvidenceSchemaVersion)
    throw new Unavailable(
      `Work evidence must declare schemaVersion ${workEvidenceSchemaVersion}.`,
      "work-evidence-invalid",
    );
  only(value, ["schemaVersion", "suite", "contractSha256", "operations"], "Work evidence");
  if (value.suite !== suite)
    throw new Unavailable(
      `Work evidence suite ${JSON.stringify(value.suite)} does not match contract suite ${JSON.stringify(suite)}.`,
      "work-evidence-mismatched",
    );
  if (value.contractSha256 !== contractSha256)
    throw new Unavailable(
      "Work evidence was produced for a different contract revision (contractSha256 mismatch).",
      "work-evidence-stale",
    );
  if (!Array.isArray(value.operations))
    throw new Unavailable("Work evidence operations must be an array.", "work-evidence-invalid");
  const result = new Map<string, Map<string, Sample>>();
  for (const [index, entry] of value.operations.entries()) {
    const where = `Work evidence operations[${index}]`;
    if (!record(entry) || typeof entry.id !== "string" || !Array.isArray(entry.samples))
      throw new Unavailable(`${where} needs an id and samples.`, "work-evidence-invalid");
    only(entry, ["id", "samples"], where);
    const declared = operations.find((operation) => operation.id === entry.id);
    if (!declared)
      throw new Unavailable(
        `${where} reports undeclared operation ${entry.id}.`,
        "work-evidence-mismatched",
      );
    if (result.has(entry.id))
      throw new Unavailable(`${where} repeats operation ${entry.id}.`, "work-evidence-invalid");
    const declaredPoints = new Set(
      declared.scalePoints.map((point) => scaleKey(point, declared.dimensions)),
    );
    const samples = new Map<string, Sample>();
    for (const [sampleIndex, rawSample] of entry.samples.entries()) {
      const at = `${where}.samples[${sampleIndex}]`;
      if (!record(rawSample) || !record(rawSample.dimensions) || !record(rawSample.metrics))
        throw new Unavailable(`${at} needs dimensions and metrics.`, "work-evidence-invalid");
      only(rawSample, ["dimensions", "metrics"], at);
      const dimensions = rawSample.dimensions;
      const metrics = rawSample.metrics;
      only(dimensions, declared.dimensions, `${at}.dimensions`);
      const point: Point = {};
      for (const dimension of declared.dimensions) {
        const scale = dimensions[dimension];
        if (typeof scale !== "number")
          throw new Unavailable(`${at} omits dimension ${dimension}.`, "work-evidence-incomplete");
        point[dimension] = scale;
      }
      const key = scaleKey(point, declared.dimensions);
      if (!declaredPoints.has(key))
        throw new Unavailable(
          `${at} is not a declared scale point of ${declared.id}.`,
          "work-evidence-mismatched",
        );
      if (samples.has(key))
        throw new Unavailable(`${at} repeats a scale point.`, "work-evidence-invalid");
      only(
        metrics,
        declared.metrics.map((metric) => metric.name),
        `${at}.metrics`,
      );
      const values: Record<string, number> = {};
      for (const metric of declared.metrics) {
        const observed = metrics[metric.name];
        if (observed === undefined)
          throw new Unavailable(
            `${at} omits metric ${metric.name}; a missing metric is not zero.`,
            "work-evidence-incomplete",
          );
        if (!counter(observed))
          throw new Unavailable(
            `${at}.metrics.${metric.name} must be a non-negative integer counter.`,
            "work-evidence-invalid",
          );
        values[metric.name] = observed;
      }
      samples.set(key, { dimensions: point, metrics: values });
    }
    for (const point of declared.scalePoints)
      if (!samples.has(scaleKey(point, declared.dimensions)))
        throw new Unavailable(
          `Work evidence for ${declared.id} omits declared scale point ${JSON.stringify(point)}.`,
          "work-evidence-incomplete",
        );
    result.set(entry.id, samples);
  }
  for (const operation of operations)
    if (!result.has(operation.id))
      throw new Unavailable(
        `Work evidence omits declared operation ${operation.id}.`,
        "work-evidence-incomplete",
      );
  return result;
}

/**
 * Within every group of samples that agree on all other dimensions, compare each sample with the
 * group's smallest value x0 of the bounded dimension:
 * constant => v(x) <= v(x0); linear => v(x) * x0 <= v(x0) * x (exact integer arithmetic).
 */
function growthCheck(
  operation: WorkOperation,
  samples: Sample[],
  metric: string,
  dimension: string,
  bound: GrowthBound,
): WorkCheck {
  const others = operation.dimensions.filter((value) => value !== dimension);
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = scaleKey(sample.dimensions, others);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const violations: Violation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = group.reduce((smallest, sample) =>
      sample.dimensions[dimension]! < smallest.dimensions[dimension]! ? sample : smallest,
    );
    const x0 = BigInt(ordered.dimensions[dimension]!);
    const v0 = BigInt(ordered.metrics[metric]!);
    for (const sample of group) {
      if (sample === ordered) continue;
      const x = BigInt(sample.dimensions[dimension]!);
      const v = BigInt(sample.metrics[metric]!);
      const within = bound === "constant" ? v <= v0 : v * x0 <= v0 * x;
      if (!within)
        violations.push({
          point: sample.dimensions,
          value: sample.metrics[metric]!,
          baseline: ordered.dimensions,
          baselineValue: ordered.metrics[metric]!,
        });
    }
  }
  return {
    metric,
    kind: "growth",
    dimension,
    bound,
    state: violations.length ? "failed" : "passed",
    violations,
  };
}

function evaluate(operation: WorkOperation, byPoint: Map<string, Sample>): OperationResult {
  // Declared scale-point order keeps the report independent of evidence order.
  const samples = operation.scalePoints.map((point) =>
    byPoint.get(scaleKey(point, operation.dimensions))!,
  );
  const checks: WorkCheck[] = [];
  for (const metric of operation.metrics) {
    if (metric.budget !== null) {
      const max = metric.budget.max;
      const violations = samples
        .filter((sample) => sample.metrics[metric.name]! > max)
        .map((sample) => ({ point: sample.dimensions, value: sample.metrics[metric.name]! }));
      checks.push({
        metric: metric.name,
        kind: "budget",
        max,
        state: violations.length ? "failed" : "passed",
        violations,
      });
    }
    for (const { dimension, bound } of metric.growth)
      checks.push(growthCheck(operation, samples, metric.name, dimension, bound));
  }
  return {
    id: operation.id,
    description: operation.description,
    publicContract: operation.publicContract,
    dimensions: operation.dimensions,
    scalePoints: operation.scalePoints.length,
    checks,
  };
}

/**
 * Verify repository-emitted deterministic work counters against the declared operation contracts.
 * Never infers complexity from timings; missing, stale or incomplete evidence is unavailable.
 */
export function workComplexityEvidence(
  root: string,
  options: { evidence?: string } = {},
): ResultEnvelope<WorkComplexityData> {
  const started = Date.now();
  const resolvedRoot = resolve(root);
  const diagnostics: Diagnostic[] = [];
  const data: WorkComplexityData = {
    schemaVersion: "coding-tooling/work-complexity/v1",
    root: resolvedRoot,
    contract: { path: performanceContractPath, schemaVersion: null },
    suite: null,
    contractSha256: null,
    evidence: { source: null, command: null, path: null, sha256: null },
    operations: [],
    limitations: [
      "Checks verify repository-emitted deterministic counters at the declared scale points only; they do not prove asymptotic complexity between or beyond those points.",
      "Operation semantics, fixtures, counters and budgets are repository-owned; wall-clock latency is out of scope.",
    ],
  };
  try {
    const contractFile = resolve(resolvedRoot, performanceContractPath);
    if (!existsSync(contractFile))
      throw new Unavailable(
        `Missing ${performanceContractPath}.`,
        "performance-contract-missing",
        performanceContractPath,
      );
    const bytes = readFileSync(contractFile);
    data.contractSha256 = hash(bytes);
    let contract;
    try {
      contract = parsePerformanceContract(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      throw new Unavailable(
        `Invalid performance contract: ${error instanceof Error ? error.message : String(error)}`,
        "performance-contract-invalid",
        performanceContractPath,
      );
    }
    data.contract.schemaVersion = contract.schemaVersion;
    data.suite = contract.suite;
    if (contract.operations.length === 0)
      throw new Unavailable(
        "The performance contract declares no operations; there is no work contract to verify.",
        "work-operations-missing",
        performanceContractPath,
      );
    const text =
      options.evidence === undefined
        ? collect(resolvedRoot, data)
        : readEvidenceFile(resolvedRoot, options.evidence, data);
    data.evidence.sha256 = hash(text);
    const evidence = parseEvidence(text, contract.suite, data.contractSha256, contract.operations);
    data.operations = contract.operations.map((operation) =>
      evaluate(operation, evidence.get(operation.id)!),
    );
  } catch (error) {
    if (error instanceof Unavailable)
      diagnostics.push({
        code: error.code,
        message: error.message,
        ...(error.path ? { path: error.path } : {}),
      });
    else
      diagnostics.push({
        code: "work-complexity-unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
  }
  let status: ResultEnvelope<WorkComplexityData>["status"] = "passed";
  if (diagnostics.length) status = "unavailable";
  else if (data.operations.some((operation) => operation.checks.some((c) => c.state === "failed")))
    status = "failed";
  return {
    schemaVersion: 1,
    operation: "work-complexity",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}
