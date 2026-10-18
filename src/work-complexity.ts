import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declaredComponents, loadConfig } from "./core.ts";
import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  type GrowthBound,
  type GrowthSpec,
  type GrowthTerm,
  growthModel,
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
  /**
   * For a `linear` marginal-rate violation (groups of three or more points): the preceding point
   * of the interval whose per-unit marginal work exceeded the first interval's rate.
   */
  previous?: Point;
  previousValue?: number;
  /**
   * For the tolerant rate test (three or more points): the least-squares work per model unit over
   * the lower and upper halves of the group, and the largest upper rate the bound allows.
   */
  lowerRate?: number;
  upperRate?: number;
  allowedRate?: number;
};
export type WorkCheck = {
  metric: string;
  kind: "growth" | "budget";
  /** A single-dimension bound. */
  dimension?: string;
  bound?: GrowthBound;
  degree?: number;
  logDegree?: number;
  /** A joint product bound over several dimensions, e.g. O(m · log n). */
  product?: GrowthTerm[];
  /** Relative slack of the tolerant rate test; absent for the exact classes. */
  tolerance?: number;
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
  // A polyglot root can hold several components at "."; only those exposing the capability count.
  const commands = declaredComponents(root, loadConfig(root))
    .filter((value) => value.path === ".")
    .flatMap((value) => {
      const declared = value.capabilities[capability];
      return declared?.length ? [{ name: value.name, command: declared }] : [];
    });
  const command = commands[0]?.command;
  if (!command)
    throw new Unavailable(
      `No root component declares a ${capability} capability command.`,
      "work-collector-unavailable",
      ".coding-tooling.json",
    );
  if (commands.some((value) => JSON.stringify(value.command) !== JSON.stringify(command)))
    throw new Unavailable(
      `Root components declare different ${capability} commands (${commands
        .map((value) => value.name)
        .join(", ")}); the collector is ambiguous.`,
      "work-collector-ambiguous",
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
      const point: Point = Object.create(null);
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
      const values: Record<string, number> = Object.create(null);
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

/** Least-squares slope of v against g; 0 when the g values do not vary. */
function slope(g: number[], v: number[]): number {
  const n = g.length;
  const gm = g.reduce((sum, value) => sum + value, 0) / n;
  const vm = v.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index++) {
    numerator += (g[index]! - gm) * (v[index]! - vm);
    denominator += (g[index]! - gm) ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Within every group of samples that agree on all dimensions outside the bound, v is the counter
 * (a non-negative integer). See docs/work-complexity.md for the full semantics.
 *
 * Exact classes, ordering the group by the bounded dimension x0 < x1 < … < xk (BigInt arithmetic):
 * - constant: v(xi) <= v(x0) for every i.
 * - linear, two points: v(x1) * x0 <= v(x0) * x1 (the ratio test).
 * - linear, three or more points: the per-unit marginal work of every later interval must not
 *   exceed the first interval's, i.e. for every i >= 1
 *   (v(x[i+1]) - v(x[i])) * (x1 - x0) <= max(v(x1) - v(x0), 0) * (x[i+1] - x[i]).
 *
 * Every other class (and every product bound) maps each point to its model work
 * g = Π x^degree · (1 + log2 x)^logDegree and orders the group by g:
 * - two points: v1 <= (1 + t) · v0 · g1 / g0 + 1.
 * - three or more points: the least-squares rate dv/dg of the upper half of the group must not
 *   exceed (1 + t) times the lower half's (floored at 0) plus one counter unit over the upper
 *   half's g span. Affine work a·g + b of either sign of b passes; a faster class fails once the
 *   points span enough of it, and single integer steps (a tree level, a rounding) are absorbed.
 */
function growthCheck(
  operation: WorkOperation,
  samples: Sample[],
  metric: string,
  spec: GrowthSpec,
): WorkCheck {
  const bounded = spec.terms.map((term) => term.dimension);
  const others = operation.dimensions.filter((value) => !bounded.includes(value));
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = scaleKey(sample.dimensions, others);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const single = spec.terms.length === 1 && !spec.product ? spec.terms[0]! : null;
  const model = (sample: Sample) =>
    spec.terms.reduce(
      (work, term) => work * growthModel(term, sample.dimensions[term.dimension]!),
      1,
    );
  const violations: Violation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = single
      ? group.toSorted(
          (left, right) => left.dimensions[single.dimension]! - right.dimensions[single.dimension]!,
        )
      : group.toSorted((left, right) => model(left) - model(right));
    const first = ordered[0]!;
    const violation = (
      index: number,
      previous?: Sample,
      rates?: Partial<Violation>,
    ): Violation => ({
      point: ordered[index]!.dimensions,
      value: ordered[index]!.metrics[metric]!,
      baseline: first.dimensions,
      baselineValue: first.metrics[metric]!,
      ...(previous === undefined
        ? {}
        : { previous: previous.dimensions, previousValue: previous.metrics[metric]! }),
      ...rates,
    });
    if (single && single.bound === "constant") {
      const v = ordered.map((sample) => sample.metrics[metric]!);
      for (let index = 1; index < ordered.length; index++)
        if (v[index]! > v[0]!) violations.push(violation(index));
    } else if (single && single.bound === "linear") {
      // Points within a group differ only in the bounded dimension, so its values are distinct.
      const x = ordered.map((sample) => BigInt(sample.dimensions[single.dimension]!));
      const v = ordered.map((sample) => BigInt(sample.metrics[metric]!));
      if (ordered.length === 2) {
        if (v[1]! * x[0]! > v[0]! * x[1]!) violations.push(violation(1));
      } else {
        // A decreasing first interval would make every later flat interval fail; a non-negative
        // reference rate keeps "drops, then stays flat" within the bound.
        const firstWork = v[1]! > v[0]! ? v[1]! - v[0]! : 0n;
        const firstSpan = x[1]! - x[0]!;
        for (let index = 1; index + 1 < ordered.length; index++) {
          const work = v[index + 1]! - v[index]!;
          const span = x[index + 1]! - x[index]!;
          if (work * firstSpan > firstWork * span)
            violations.push(violation(index + 1, ordered[index]!));
        }
      }
    } else {
      const t = spec.tolerance!;
      const g = ordered.map(model);
      const v = ordered.map((sample) => sample.metrics[metric]!);
      const n = ordered.length;
      if (n === 2) {
        if (v[1]! > (1 + t) * v[0]! * (g[1]! / g[0]!) + 1 + 1e-9) violations.push(violation(1));
      } else {
        const half = Math.ceil(n / 2);
        const lower = slope(g.slice(0, half), v.slice(0, half));
        const upperG = g.slice(n - half);
        const upper = slope(upperG, v.slice(n - half));
        const span = upperG[upperG.length - 1]! - upperG[0]!;
        const allowed = (1 + t) * Math.max(lower, 0) + (span > 0 ? 1 / span : 0);
        if (upper > allowed * (1 + 1e-9))
          violations.push(
            violation(n - 1, ordered[n - half]!, {
              lowerRate: lower,
              upperRate: upper,
              allowedRate: allowed,
            }),
          );
      }
    }
  }
  const shape: Partial<WorkCheck> = single
    ? {
        dimension: single.dimension,
        bound: single.bound,
        ...(single.bound === "polynomial"
          ? { degree: single.degree, logDegree: single.logDegree }
          : {}),
      }
    : { product: spec.terms };
  return {
    metric,
    kind: "growth",
    ...shape,
    ...(spec.tolerance === null ? {} : { tolerance: spec.tolerance }),
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
    for (const spec of metric.growth)
      checks.push(growthCheck(operation, samples, metric.name, spec));
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
    // Latency-only operations (#302) carry no work metrics and are not part of the work contract.
    const operations = contract.operations.filter((operation) => operation.metrics.length > 0);
    if (operations.length === 0)
      throw new Unavailable(
        "The performance contract declares no operations with work metrics; there is no work contract to verify.",
        "work-operations-missing",
        performanceContractPath,
      );
    const text =
      options.evidence === undefined
        ? collect(resolvedRoot, data)
        : readEvidenceFile(resolvedRoot, options.evidence, data);
    data.evidence.sha256 = hash(text);
    const evidence = parseEvidence(text, contract.suite, data.contractSha256, operations);
    data.operations = operations.map((operation) =>
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
