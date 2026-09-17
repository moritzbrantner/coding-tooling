import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentCapabilityCatalogFragment, FlowStep } from "./agent-capabilities.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type OutputBinding = {
  contractId: string;
  stepId: string;
};

type ContractCatalogEntry = {
  id: string;
  schema: string;
};

function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${label} must be an object`);
  return value;
}

function readJson(path: string, label: string): JsonObject {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")) as JsonValue, label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} must`)) throw error;
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function contractEntries(contractsRoot: string): ContractCatalogEntry[] {
  const catalog = readJson(resolve(contractsRoot, "CATALOG.json"), "agent-contracts CATALOG.json");
  const rawContracts = catalog.contracts;
  if (!Array.isArray(rawContracts)) throw new Error("agent-contracts CATALOG.json contracts must be an array");
  return rawContracts.map((entry, index) => {
    const object = asObject(entry, `agent-contracts CATALOG.json contracts[${index}]`);
    if (typeof object.id !== "string" || object.id === "")
      throw new Error(`agent-contracts CATALOG.json contracts[${index}].id must be a string`);
    if (typeof object.schema !== "string" || object.schema === "")
      throw new Error(`agent-contracts CATALOG.json contracts[${index}].schema must be a string`);
    return { id: object.id, schema: object.schema };
  });
}

function localRef(root: JsonObject, reference: string): JsonObject {
  if (!reference.startsWith("#/"))
    throw new Error(`only local JSON Schema references are supported, got ${reference}`);
  let current: JsonValue = root;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    const object = asObject(current, `JSON Schema reference ${reference}`);
    if (!(segment in object)) throw new Error(`JSON Schema reference ${reference} is unresolved`);
    current = object[segment];
  }
  return asObject(current, `JSON Schema reference ${reference}`);
}

function dereference(node: JsonObject, root: JsonObject): JsonObject {
  const reference = node.$ref;
  return typeof reference === "string" ? localRef(root, reference) : node;
}

function propertySchemas(
  node: JsonObject,
  property: string,
  root: JsonObject,
  visited: Set<JsonObject> = new Set(),
): JsonObject[] {
  const resolved = dereference(node, root);
  if (visited.has(resolved)) return [];
  visited.add(resolved);

  const matches: JsonObject[] = [];
  if (resolved.properties && !Array.isArray(resolved.properties) && typeof resolved.properties === "object") {
    const properties = resolved.properties as JsonObject;
    const candidate = properties[property];
    if (candidate && !Array.isArray(candidate) && typeof candidate === "object")
      matches.push(candidate as JsonObject);
  }

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = resolved[keyword];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || Array.isArray(variant) || typeof variant !== "object") continue;
      matches.push(...propertySchemas(variant as JsonObject, property, root, new Set(visited)));
    }
  }
  return matches;
}

function schemasAtPath(root: JsonObject, path: string[]): JsonObject[] {
  let current = [root];
  for (const segment of path) {
    current = current.flatMap((schema) => propertySchemas(schema, segment, root));
    if (current.length === 0) return [];
  }
  return current;
}

function scalarTypeMatches(type: string, value: string | number | boolean | null): boolean {
  if (type === "null") return value === null;
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return true;
}

function sameScalar(left: JsonValue | undefined, right: string | number | boolean | null): boolean {
  return left === right;
}

function acceptsScalar(
  node: JsonObject,
  value: string | number | boolean | null,
  root: JsonObject,
): boolean {
  const resolved = dereference(node, root);

  const oneOf = resolved.oneOf;
  if (Array.isArray(oneOf)) {
    const variants = oneOf.filter(
      (variant): variant is JsonObject => Boolean(variant) && !Array.isArray(variant) && typeof variant === "object",
    );
    if (variants.length > 0 && !variants.some((variant) => acceptsScalar(variant, value, root))) return false;
  }
  const anyOf = resolved.anyOf;
  if (Array.isArray(anyOf)) {
    const variants = anyOf.filter(
      (variant): variant is JsonObject => Boolean(variant) && !Array.isArray(variant) && typeof variant === "object",
    );
    if (variants.length > 0 && !variants.some((variant) => acceptsScalar(variant, value, root))) return false;
  }
  const allOf = resolved.allOf;
  if (Array.isArray(allOf)) {
    const variants = allOf.filter(
      (variant): variant is JsonObject => Boolean(variant) && !Array.isArray(variant) && typeof variant === "object",
    );
    if (variants.some((variant) => !acceptsScalar(variant, value, root))) return false;
  }

  if (resolved.const !== undefined && !sameScalar(resolved.const, value)) return false;
  if (Array.isArray(resolved.enum) && !resolved.enum.some((entry) => sameScalar(entry, value))) return false;

  const rawType = resolved.type;
  if (typeof rawType === "string" && !scalarTypeMatches(rawType, value)) return false;
  if (
    Array.isArray(rawType) &&
    rawType.every((entry) => typeof entry !== "string" || !scalarTypeMatches(entry, value))
  )
    return false;

  if (typeof resolved.pattern === "string" && typeof value === "string") {
    if (!new RegExp(resolved.pattern).test(value)) return false;
  }
  return true;
}

function collectOutputBindings(steps: FlowStep[], target: Map<string, OutputBinding>): void {
  for (const step of steps) {
    if (step.kind === "invoke") {
      if (step.outputContract && !step.output)
        throw new Error(`invoke step ${step.id} declares output-contract without output`);
      if (step.output && step.outputContract) {
        const existing = target.get(step.output);
        if (existing && existing.contractId !== step.outputContract) {
          throw new Error(
            `flow output ${step.output} is bound to conflicting contracts ${existing.contractId} and ${step.outputContract}`,
          );
        }
        target.set(step.output, { contractId: step.outputContract, stepId: step.id });
      }
    } else if (step.kind === "parallel") collectOutputBindings(step.steps, target);
    else if (step.kind === "branch") {
      collectOutputBindings(step.whenTrue, target);
      if (step.whenFalse) collectOutputBindings(step.whenFalse, target);
    }
  }
}

function validateBranchConditions(
  steps: FlowStep[],
  outputs: Map<string, OutputBinding>,
  schemas: Map<string, JsonObject>,
  capabilityId: string,
): void {
  for (const step of steps) {
    if (step.kind === "branch") {
      const [outputName, ...fieldPath] = step.condition.source.split(".");
      const binding = outputs.get(outputName);
      if (binding) {
        const schema = schemas.get(binding.contractId);
        if (!schema) throw new Error(`${capabilityId} output contract ${binding.contractId} is unresolved`);
        const candidates = fieldPath.length === 0 ? [schema] : schemasAtPath(schema, fieldPath);
        if (candidates.length === 0) {
          throw new Error(
            `${capabilityId} branch ${step.id} source ${step.condition.source} is not present in ${binding.contractId}`,
          );
        }
        if (!candidates.some((candidate) => acceptsScalar(candidate, step.condition.equals, schema))) {
          throw new Error(
            `${capabilityId} branch ${step.id} value ${JSON.stringify(step.condition.equals)} is not accepted by ${binding.contractId} at ${step.condition.source}`,
          );
        }
      }
      validateBranchConditions(step.whenTrue, outputs, schemas, capabilityId);
      if (step.whenFalse) validateBranchConditions(step.whenFalse, outputs, schemas, capabilityId);
    } else if (step.kind === "parallel") validateBranchConditions(step.steps, outputs, schemas, capabilityId);
  }
}

export function validateContractBoundFlowConditions(
  catalog: AgentCapabilityCatalogFragment,
  contractsRoot?: string,
): void {
  const outputsByCapability = new Map<string, Map<string, OutputBinding>>();
  const requiredContractIds = new Set<string>();
  for (const capability of catalog.capabilities) {
    if (!capability.flow) continue;
    const outputs = new Map<string, OutputBinding>();
    collectOutputBindings(capability.flow.steps, outputs);
    outputsByCapability.set(capability.id, outputs);
    for (const binding of outputs.values()) requiredContractIds.add(binding.contractId);
  }
  if (requiredContractIds.size === 0) return;
  if (!contractsRoot)
    throw new Error("contract-bound capability outputs require an explicit agent-contracts root");

  const entries = contractEntries(contractsRoot);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const schemas = new Map<string, JsonObject>();
  const root = resolve(contractsRoot);
  for (const contractId of requiredContractIds) {
    const entry = byId.get(contractId);
    if (!entry) throw new Error(`agent-contracts catalog does not contain ${contractId}`);
    const schemaPath = resolve(root, entry.schema);
    if (schemaPath !== root && !schemaPath.startsWith(`${root}/`) && !schemaPath.startsWith(`${root}\\`))
      throw new Error(`agent-contracts schema path escapes root: ${entry.schema}`);
    schemas.set(contractId, readJson(schemaPath, `${contractId} schema`));
  }

  for (const capability of catalog.capabilities) {
    if (!capability.flow) continue;
    validateBranchConditions(
      capability.flow.steps,
      outputsByCapability.get(capability.id) ?? new Map(),
      schemas,
      capability.id,
    );
  }
}
