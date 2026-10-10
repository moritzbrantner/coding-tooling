/**
 * Structural validation for `.performance/contract.json`.
 *
 * schemaVersion 1 declares benchmark scenarios. schemaVersion 2 is schemaVersion 1 plus optional
 * operation-level work contracts (`operations`). A v1 contract is read as a v2 contract without
 * operations; it must not carry `operations`, so a v2 field cannot be silently ignored.
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
export const growthBounds = ["constant", "linear"] as const;
export type GrowthBound = (typeof growthBounds)[number];

export type WorkMetric = {
  name: string;
  unit: string;
  signal: string;
  budget: { max: number } | null;
  growth: { dimension: string; bound: GrowthBound }[];
};
export type WorkOperation = {
  id: string;
  description: string;
  publicContract: string | null;
  dimensions: string[];
  scalePoints: Record<string, number>[];
  metrics: WorkMetric[];
};
export type PerformanceContract = {
  schemaVersion: 1 | 2;
  suite: string;
  operations: WorkOperation[];
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
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A canonical, order-independent key for one scale point restricted to `dimensions`. */
export function scaleKey(point: Record<string, number>, dimensions: readonly string[]): string {
  return JSON.stringify(dimensions.map((dimension) => point[dimension]));
}

function validateScenarios(contract: Record<string, unknown>): void {
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
  }
}

function parseMetric(raw: unknown, prefix: string, dimensions: string[]): WorkMetric {
  const metric = record(raw);
  if (!metric) throw new ContractError(`${prefix} must be an object`);
  only(metric, ["name", "unit", "signal", "budget", "growth", "notes"], prefix);
  if (!nonEmptyString(metric.name)) throw new ContractError(`${prefix}.name must be non-empty`);
  if (!nonEmptyString(metric.unit)) throw new ContractError(`${prefix}.unit must be non-empty`);
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
  const growth = rawGrowth.map((entry: unknown, index) => {
    const value = record(entry);
    const growthPrefix = `${prefix}.growth[${index}]`;
    if (!value) throw new ContractError(`${growthPrefix} must be an object`);
    only(value, ["dimension", "bound"], growthPrefix);
    if (typeof value.dimension !== "string" || !dimensions.includes(value.dimension))
      throw new ContractError(`${growthPrefix}.dimension must name a declared dimension`);
    if (!growthBounds.some((bound) => bound === value.bound))
      throw new ContractError(`${growthPrefix}.bound must be one of ${growthBounds.join(", ")}`);
    return { dimension: value.dimension, bound: value.bound as GrowthBound };
  });
  if (new Set(growth.map((value) => value.dimension)).size !== growth.length)
    throw new ContractError(`${prefix}.growth declares a dimension more than once`);
  if (budget === null && growth.length === 0)
    throw new ContractError(`${prefix} declares neither a budget nor a growth bound`);
  return { name: metric.name, unit: metric.unit, signal: String(metric.signal), budget, growth };
}

function parseOperation(raw: unknown, prefix: string): WorkOperation {
  const operation = record(raw);
  if (!operation) throw new ContractError(`${prefix} must be an object`);
  only(
    operation,
    ["id", "description", "publicContract", "dimensions", "scalePoints", "metrics"],
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
    if (!identifier.test(name) || !dimension)
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
    const values: Record<string, number> = {};
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
  if (!Array.isArray(operation.metrics) || operation.metrics.length === 0)
    throw new ContractError(`${prefix}.metrics must be a non-empty array`);
  const metrics = operation.metrics.map((entry: unknown, index) =>
    parseMetric(entry, `${prefix}.metrics[${index}]`, dimensions),
  );
  if (new Set(metrics.map((metric) => metric.name)).size !== metrics.length)
    throw new ContractError(`${prefix}.metrics names must be unique`);
  // A growth bound is only executable when some group of scale points varies its dimension.
  for (const metric of metrics)
    for (const { dimension } of metric.growth) {
      const others = dimensions.filter((value) => value !== dimension);
      const groups = new Map<string, Set<number>>();
      for (const point of scalePoints) {
        const key = scaleKey(point, others);
        groups.set(key, (groups.get(key) ?? new Set()).add(point[dimension]!));
      }
      if (![...groups.values()].some((values) => values.size >= 2))
        throw new ContractError(
          `${prefix}.metrics ${metric.name}: no scale points vary ${dimension} while holding the other dimensions fixed`,
        );
    }
  return {
    id: operation.id,
    description: operation.description,
    publicContract: nonEmptyString(operation.publicContract) ? operation.publicContract : null,
    dimensions,
    scalePoints,
    metrics,
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
  validateScenarios(contract);
  let operations: WorkOperation[] = [];
  if (contract.schemaVersion === 2 && contract.operations !== undefined) {
    if (!Array.isArray(contract.operations)) throw new ContractError("operations must be an array");
    operations = contract.operations.map((entry: unknown, index) =>
      parseOperation(entry, `operations[${index}]`),
    );
    if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
      throw new ContractError("operations ids must be unique");
  }
  return { schemaVersion: contract.schemaVersion, suite: contract.suite, operations };
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
