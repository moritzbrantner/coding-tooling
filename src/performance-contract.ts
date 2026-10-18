/**
 * Structural validation for `.performance/contract.json`.
 *
 * schemaVersion 1 declares benchmark scenarios. schemaVersion 2 is schemaVersion 1 plus optional
 * operation-level work contracts (`operations`). A v1 contract is read as a v2 contract without
 * operations; it must not carry `operations`, so a v2 field cannot be silently ignored. Either
 * version may give a scenario an optional `controlled.history` block (docs/performance-history.md).
 * A v2 operation may carry an optional `latency` deadline bound to such a scenario and may then
 * omit work `metrics` (docs/performance-acceptance.md).
 */

export const performanceContractPath = ".performance/contract.json";

const scenarioKinds = new Set(["common", "idle", "scaling", "stress", "journey", "micro"]);
const directions = new Set(["lower", "higher"]);
export const performanceSignals = new Set([
  "operation-count",
  "allocation-count",
  "instruction-count",
  "cache-event-count",
  "wall-clock",
  "memory",
  "size",
  "throughput",
  "custom",
]);
/** Work metrics must be deterministic counters; timing-shaped signals stay with runtime evidence. */
const workSignals = new Set([
  "operation-count",
  "allocation-count",
  "instruction-count",
  "cache-event-count",
  "memory",
  "size",
  "custom",
]);
export const growthBounds = [
  "constant",
  "logarithmic",
  "linear",
  "linearithmic",
  "quadratic",
  "cubic",
  "polynomial",
] as const;
export type GrowthBound = (typeof growthBounds)[number];
/** `constant` and `linear` are checked exactly; every other class with the tolerant rate test. */
export const exactGrowthBounds: readonly GrowthBound[] = ["constant", "linear"];
/** Default relative slack of the tolerant rate test (see docs/work-complexity.md). */
export const defaultGrowthTolerance = 0.25;
const maxGrowthTolerance = 4;
const maxPolynomialDegree = 8;
/** The class x^degree · log(x)^logDegree that one dimension's bound names. */
export type GrowthTerm = {
  dimension: string;
  bound: GrowthBound;
  degree: number;
  logDegree: number;
};
/**
 * One growth bound: a single dimension (`terms` has one entry and `product` is false) or a joint
 * `product` bound over several dimensions, e.g. O(m · log n). `tolerance` is null for the exact
 * classes.
 */
export type GrowthSpec = {
  product: boolean;
  terms: GrowthTerm[];
  tolerance: number | null;
};
const classDegrees: Record<Exclude<GrowthBound, "polynomial">, [number, number]> = {
  constant: [0, 0],
  logarithmic: [0, 1],
  linear: [1, 0],
  linearithmic: [1, 1],
  quadratic: [2, 0],
  cubic: [3, 0],
};

/** Model work of one term at scale x >= 1: x^degree · (1 + log2 x)^logDegree, always >= 1. */
export function growthModel(term: GrowthTerm, x: number): number {
  return x ** term.degree * (1 + Math.log2(x)) ** term.logDegree;
}

export type WorkMetric = {
  name: string;
  unit: string;
  signal: string;
  budget: { max: number } | null;
  growth: GrowthSpec[];
};
export type WorkOperation = {
  id: string;
  description: string;
  publicContract: string | null;
  dimensions: string[];
  scalePoints: Record<string, number>[];
  /** Empty for a latency-only operation. */
  metrics: WorkMetric[];
  latency: LatencyDeadline | null;
};
export const latencyRatchets = ["informational", "blocking"] as const;
/**
 * Optional per-operation wall-clock deadline (#302): the bound scenario's recorded runtime-profiler
 * `statistic` of `metric` must be at most `maxMs`.
 */
export type LatencyDeadline = {
  /** Contract scenario id; the scenario declares `controlled.history`. */
  scenario: string;
  /** runtime-profiler metric id, e.g. `process.wall_time`. */
  metric: string;
  /** runtime-profiler statistic, e.g. `median`, `p95`, `mean`. */
  statistic: string;
  maxMs: number;
  ratchet: (typeof latencyRatchets)[number];
};
/**
 * Optional per-scenario pointer to controlled performance history: a runtime-profiler
 * score-history document stored on a data-only branch of the same repository.
 */
export type ControlledHistory = {
  /** Contract scenario id that declares the block. */
  id: string;
  branch: string;
  /** Repository-relative POSIX path of the history document on `branch`. */
  path: string;
  /** runtime-profiler `scenario_id` filter; defaults to the contract scenario id. */
  scenario: string;
};
export type PerformanceContract = {
  schemaVersion: 1 | 2;
  suite: string;
  operations: WorkOperation[];
  /** Scenarios that declare `controlled.history`, in contract order. */
  controlled: ControlledHistory[];
};

class ContractError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function only(value: Record<string, unknown>, allowed: string[], prefix: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new ContractError(`${prefix} has unknown field ${unknown}`);
}

const kebab = /^[a-z0-9][a-z0-9-]*$/;
/** Names that would hit inherited accessors when used as plain-object keys. */
const prototypeSensitive = new Set(["__proto__", "constructor", "prototype"]);
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A canonical, order-independent key for one scale point restricted to `dimensions`. */
export function scaleKey(point: Record<string, number>, dimensions: readonly string[]): string {
  return JSON.stringify(dimensions.map((dimension) => point[dimension]));
}

function parseControlled(raw: unknown, id: string, prefix: string): ControlledHistory {
  const controlled = record(raw);
  if (!controlled) throw new ContractError(`${prefix} must be an object`);
  only(controlled, ["history"], prefix);
  const history = record(controlled.history);
  if (!history) throw new ContractError(`${prefix}.history must be an object`);
  only(history, ["branch", "path", "scenario"], `${prefix}.history`);
  if (!nonEmptyString(history.branch))
    throw new ContractError(`${prefix}.history.branch must be a non-empty string`);
  if (!nonEmptyString(history.path))
    throw new ContractError(`${prefix}.history.path must be a non-empty string`);
  const segments = history.path.split(/[\\/]/);
  if (/^([\\/]|[A-Za-z]:)/.test(history.path) || segments.includes(".."))
    throw new ContractError(
      `${prefix}.history.path must be a repository-relative path without .. segments`,
    );
  if (history.scenario !== undefined && !nonEmptyString(history.scenario))
    throw new ContractError(`${prefix}.history.scenario must be a non-empty string`);
  return {
    id,
    branch: history.branch,
    path: history.path,
    scenario: nonEmptyString(history.scenario) ? history.scenario : id,
  };
}

function validateScenarios(contract: Record<string, unknown>): ControlledHistory[] {
  const controlled: ControlledHistory[] = [];
  if (!Array.isArray(contract.scenarios) || contract.scenarios.length === 0)
    throw new ContractError("scenarios must be a non-empty array");
  for (const [scenarioIndex, rawScenario] of contract.scenarios.entries()) {
    const scenario = record(rawScenario);
    const prefix = `scenarios[${scenarioIndex}]`;
    if (!scenario) throw new ContractError(`${prefix} must be an object`);
    if (!nonEmptyString(scenario.id) || !kebab.test(scenario.id))
      throw new ContractError(`${prefix}.id must be a kebab-case identifier`);
    if (!scenarioKinds.has(String(scenario.kind)))
      throw new ContractError(`${prefix}.kind is not supported`);
    if (!nonEmptyString(scenario.description))
      throw new ContractError(`${prefix}.description must be a non-empty string`);
    if (!record(scenario.dimensions))
      throw new ContractError(`${prefix}.dimensions must be an object`);
    if (!Array.isArray(scenario.metrics) || scenario.metrics.length === 0)
      throw new ContractError(`${prefix}.metrics must be a non-empty array`);
    for (const [metricIndex, rawMetric] of scenario.metrics.entries()) {
      const metric = record(rawMetric);
      const metricPrefix = `${prefix}.metrics[${metricIndex}]`;
      if (!metric) throw new ContractError(`${metricPrefix} must be an object`);
      if (!nonEmptyString(metric.name))
        throw new ContractError(`${metricPrefix}.name must be a non-empty string`);
      if (!nonEmptyString(metric.unit))
        throw new ContractError(`${metricPrefix}.unit must be a non-empty string`);
      if (!directions.has(String(metric.direction)))
        throw new ContractError(`${metricPrefix}.direction must be lower or higher`);
      if (!performanceSignals.has(String(metric.signal)))
        throw new ContractError(`${metricPrefix}.signal is not supported`);
      if (typeof metric.blocking !== "boolean")
        throw new ContractError(`${metricPrefix}.blocking must be boolean`);
      if (
        metric.blocking === true &&
        metric.signal === "wall-clock" &&
        !nonEmptyString(metric.notes)
      )
        throw new ContractError(
          `${metricPrefix} uses blocking wall-clock evidence without documenting the controlled execution boundary`,
        );
    }
    if (scenario.controlled !== undefined)
      controlled.push(parseControlled(scenario.controlled, scenario.id, `${prefix}.controlled`));
  }
  return controlled;
}

function parseMetric(raw: unknown, prefix: string, dimensions: string[]): WorkMetric {
  const metric = record(raw);
  if (!metric) throw new ContractError(`${prefix} must be an object`);
  only(metric, ["name", "unit", "signal", "budget", "growth", "notes"], prefix);
  if (!nonEmptyString(metric.name)) throw new ContractError(`${prefix}.name must be non-empty`);
  if (prototypeSensitive.has(metric.name))
    throw new ContractError(`${prefix}.name ${metric.name} is reserved`);
  if (!nonEmptyString(metric.unit)) throw new ContractError(`${prefix}.unit must be non-empty`);
  if (metric.notes !== undefined && !nonEmptyString(metric.notes))
    throw new ContractError(`${prefix}.notes must be a non-empty string`);
  if (!workSignals.has(String(metric.signal)))
    throw new ContractError(
      `${prefix}.signal must be a deterministic counter signal (${[...workSignals].join(", ")})`,
    );
  let budget: WorkMetric["budget"] = null;
  if (metric.budget !== undefined) {
    const value = record(metric.budget);
    if (!value) throw new ContractError(`${prefix}.budget must be an object`);
    only(value, ["max"], `${prefix}.budget`);
    if (typeof value.max !== "number" || !Number.isFinite(value.max) || value.max < 0)
      throw new ContractError(`${prefix}.budget.max must be a non-negative number`);
    budget = { max: value.max };
  }
  const rawGrowth: unknown = metric.growth ?? [];
  if (!Array.isArray(rawGrowth)) throw new ContractError(`${prefix}.growth must be an array`);
  const growth = rawGrowth.map((entry: unknown, index) =>
    parseGrowth(entry, `${prefix}.growth[${index}]`, dimensions),
  );
  const singles = growth
    .filter((value) => !value.product)
    .map((value) => value.terms[0]!.dimension);
  if (new Set(singles).size !== singles.length)
    throw new ContractError(`${prefix}.growth declares a dimension more than once`);
  const products = growth
    .filter((value) => value.product)
    .map((value) => JSON.stringify(value.terms.map((term) => term.dimension).toSorted()));
  if (new Set(products).size !== products.length)
    throw new ContractError(`${prefix}.growth declares a product over the same dimensions twice`);
  if (budget === null && growth.length === 0)
    throw new ContractError(`${prefix} declares neither a budget nor a growth bound`);
  return { name: metric.name, unit: metric.unit, signal: String(metric.signal), budget, growth };
}

function parseTerm(
  value: Record<string, unknown>,
  prefix: string,
  dimensions: string[],
  extra: string[],
): GrowthTerm {
  only(value, ["dimension", "bound", "degree", "logDegree", ...extra], prefix);
  if (typeof value.dimension !== "string" || !dimensions.includes(value.dimension))
    throw new ContractError(`${prefix}.dimension must name a declared dimension`);
  if (!growthBounds.some((bound) => bound === value.bound))
    throw new ContractError(`${prefix}.bound must be one of ${growthBounds.join(", ")}`);
  const bound = value.bound as GrowthBound;
  if (bound !== "polynomial") {
    if (value.degree !== undefined || value.logDegree !== undefined)
      throw new ContractError(`${prefix}: degree and logDegree are only valid for polynomial`);
    const [degree, logDegree] = classDegrees[bound];
    return { dimension: value.dimension, bound, degree, logDegree };
  }
  const degree = value.degree;
  if (
    typeof degree !== "number" ||
    !Number.isInteger(degree) ||
    degree < 1 ||
    degree > maxPolynomialDegree
  )
    throw new ContractError(
      `${prefix}.degree must be an integer from 1 to ${maxPolynomialDegree} for polynomial`,
    );
  const logDegree = value.logDegree ?? 0;
  if (
    typeof logDegree !== "number" ||
    !Number.isInteger(logDegree) ||
    logDegree < 0 ||
    logDegree > maxPolynomialDegree
  )
    throw new ContractError(
      `${prefix}.logDegree must be an integer from 0 to ${maxPolynomialDegree}`,
    );
  return { dimension: value.dimension, bound, degree, logDegree };
}

function parseGrowth(entry: unknown, prefix: string, dimensions: string[]): GrowthSpec {
  const value = record(entry);
  if (!value) throw new ContractError(`${prefix} must be an object`);
  let terms: GrowthTerm[];
  const product = value.product !== undefined;
  if (product) {
    only(value, ["product", "tolerance"], prefix);
    if (!Array.isArray(value.product) || value.product.length < 2)
      throw new ContractError(`${prefix}.product must list at least two dimensions`);
    terms = value.product.map((raw: unknown, index) => {
      const term = record(raw);
      const termPrefix = `${prefix}.product[${index}]`;
      if (!term) throw new ContractError(`${termPrefix} must be an object`);
      const parsed = parseTerm(term, termPrefix, dimensions, []);
      if (parsed.bound === "constant")
        throw new ContractError(`${termPrefix}: a constant term adds nothing to a product`);
      return parsed;
    });
    if (new Set(terms.map((term) => term.dimension)).size !== terms.length)
      throw new ContractError(`${prefix}.product names a dimension more than once`);
  } else terms = [parseTerm(value, prefix, dimensions, ["tolerance"])];
  const exact = !product && exactGrowthBounds.includes(terms[0]!.bound);
  let tolerance: number | null = exact ? null : defaultGrowthTolerance;
  if (value.tolerance !== undefined) {
    if (exact)
      throw new ContractError(
        `${prefix}.tolerance is not valid for ${terms[0]!.bound}, which is checked exactly`,
      );
    if (
      typeof value.tolerance !== "number" ||
      !Number.isFinite(value.tolerance) ||
      value.tolerance < 0 ||
      value.tolerance > maxGrowthTolerance
    )
      throw new ContractError(
        `${prefix}.tolerance must be a number from 0 to ${maxGrowthTolerance}`,
      );
    tolerance = value.tolerance;
  }
  return { product, terms, tolerance };
}

function parseLatency(
  raw: unknown,
  prefix: string,
  controlled: ControlledHistory[],
): LatencyDeadline {
  const latency = record(raw);
  if (!latency) throw new ContractError(`${prefix} must be an object`);
  only(latency, ["scenario", "metric", "statistic", "maxMs", "ratchet"], prefix);
  for (const field of ["scenario", "metric", "statistic"] as const)
    if (!nonEmptyString(latency[field]))
      throw new ContractError(`${prefix}.${field} must be a non-empty string`);
  const scenario = latency.scenario as string;
  if (!controlled.some((value) => value.id === scenario))
    throw new ContractError(
      `${prefix}.scenario ${scenario} must name a contract scenario that declares controlled.history`,
    );
  if (typeof latency.maxMs !== "number" || !Number.isFinite(latency.maxMs) || latency.maxMs <= 0)
    throw new ContractError(`${prefix}.maxMs must be a finite number greater than 0`);
  if (latency.ratchet !== undefined && !latencyRatchets.some((value) => value === latency.ratchet))
    throw new ContractError(`${prefix}.ratchet must be one of ${latencyRatchets.join(", ")}`);
  return {
    scenario,
    metric: latency.metric as string,
    statistic: latency.statistic as string,
    maxMs: latency.maxMs,
    ratchet: latency.ratchet === "blocking" ? "blocking" : "informational",
  };
}

function parseOperation(
  raw: unknown,
  prefix: string,
  controlled: ControlledHistory[],
): WorkOperation {
  const operation = record(raw);
  if (!operation) throw new ContractError(`${prefix} must be an object`);
  only(
    operation,
    ["id", "description", "publicContract", "dimensions", "scalePoints", "metrics", "latency"],
    prefix,
  );
  if (!nonEmptyString(operation.id) || !kebab.test(operation.id))
    throw new ContractError(`${prefix}.id must be a kebab-case identifier`);
  if (!nonEmptyString(operation.description))
    throw new ContractError(`${prefix}.description must be non-empty`);
  if (operation.publicContract !== undefined && !nonEmptyString(operation.publicContract))
    throw new ContractError(`${prefix}.publicContract must be a non-empty string`);
  const declaredDimensions = record(operation.dimensions);
  if (!declaredDimensions || Object.keys(declaredDimensions).length === 0)
    throw new ContractError(`${prefix}.dimensions must declare at least one dimension`);
  for (const [name, value] of Object.entries(declaredDimensions)) {
    const dimension = record(value);
    if (!identifier.test(name) || prototypeSensitive.has(name) || !dimension)
      throw new ContractError(`${prefix}.dimensions.${name} must be an identifier with an object`);
    only(dimension, ["description"], `${prefix}.dimensions.${name}`);
    if (dimension.description !== undefined && !nonEmptyString(dimension.description))
      throw new ContractError(`${prefix}.dimensions.${name}.description must be non-empty`);
  }
  // Sorted so scale-point keys and reports do not depend on declaration order.
  // oxlint-disable-next-line unicorn/no-array-sort
  const dimensions = Object.keys(declaredDimensions).sort();
  if (!Array.isArray(operation.scalePoints) || operation.scalePoints.length === 0)
    throw new ContractError(`${prefix}.scalePoints must be a non-empty array`);
  const scalePoints = operation.scalePoints.map((entry: unknown, index) => {
    const point = record(entry);
    const pointPrefix = `${prefix}.scalePoints[${index}]`;
    if (!point) throw new ContractError(`${pointPrefix} must be an object`);
    only(point, dimensions, pointPrefix);
    const values: Record<string, number> = Object.create(null);
    for (const dimension of dimensions) {
      const value = point[dimension];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw new ContractError(`${pointPrefix}.${dimension} must be a positive integer`);
      values[dimension] = value;
    }
    return values;
  });
  const keys = scalePoints.map((point) => scaleKey(point, dimensions));
  if (new Set(keys).size !== keys.length)
    throw new ContractError(`${prefix}.scalePoints contains a duplicate scale point`);
  const latency =
    operation.latency === undefined
      ? null
      : parseLatency(operation.latency, `${prefix}.latency`, controlled);
  // A latency-only operation may omit work metrics; declared metrics are still non-empty.
  let rawMetrics: unknown[] = [];
  if (operation.metrics !== undefined || latency === null) {
    if (!Array.isArray(operation.metrics) || operation.metrics.length === 0)
      throw new ContractError(`${prefix}.metrics must be a non-empty array`);
    rawMetrics = operation.metrics;
  }
  const metrics = rawMetrics.map((entry: unknown, index) =>
    parseMetric(entry, `${prefix}.metrics[${index}]`, dimensions),
  );
  if (new Set(metrics.map((metric) => metric.name)).size !== metrics.length)
    throw new ContractError(`${prefix}.metrics names must be unique`);
  // A growth bound is only executable when some group of scale points varies its dimension.
  for (const metric of metrics)
    for (const { terms } of metric.growth) {
      const bounded = terms.map((term) => term.dimension);
      const others = dimensions.filter((value) => !bounded.includes(value));
      const groups = new Map<string, Set<string>>();
      for (const point of scalePoints) {
        const key = scaleKey(point, others);
        groups.set(key, (groups.get(key) ?? new Set()).add(scaleKey(point, bounded)));
      }
      if (![...groups.values()].some((values) => values.size >= 2))
        throw new ContractError(
          `${prefix}.metrics ${metric.name}: no scale points vary ${bounded.join(", ")} while holding the other dimensions fixed`,
        );
    }
  return {
    id: operation.id,
    description: operation.description,
    publicContract: nonEmptyString(operation.publicContract) ? operation.publicContract : null,
    dimensions,
    scalePoints,
    metrics,
    latency,
  };
}

/** Parse a v1 or v2 contract; throws with a path-qualified reason when it is invalid. */
export function parsePerformanceContract(value: unknown): PerformanceContract {
  const contract = record(value);
  if (!contract) throw new ContractError("contract root must be an object");
  if (contract.schemaVersion !== 1 && contract.schemaVersion !== 2)
    throw new ContractError("schemaVersion must equal 1 or 2");
  // The v1 root-field checks are unchanged; only the v2 field is version-gated.
  if (contract.schemaVersion === 1 && contract.operations !== undefined)
    throw new ContractError("operations requires schemaVersion 2");
  if (!nonEmptyString(contract.suite)) throw new ContractError("suite must be a non-empty string");
  const controlled = validateScenarios(contract);
  let operations: WorkOperation[] = [];
  if (contract.schemaVersion === 2 && contract.operations !== undefined) {
    if (!Array.isArray(contract.operations)) throw new ContractError("operations must be an array");
    operations = contract.operations.map((entry: unknown, index) =>
      parseOperation(entry, `operations[${index}]`, controlled),
    );
    if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
      throw new ContractError("operations ids must be unique");
  }
  return { schemaVersion: contract.schemaVersion, suite: contract.suite, operations, controlled };
}

export function performanceContractValidationError(value: unknown): string | undefined {
  try {
    parsePerformanceContract(value);
    return undefined;
  } catch (error) {
    if (error instanceof ContractError) return error.message;
    throw error;
  }
}
