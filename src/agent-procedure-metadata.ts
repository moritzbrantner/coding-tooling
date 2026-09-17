type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ProcedureMetadataObject = { [key: string]: JsonValue };

const artifactIdPattern = /^[a-z0-9][a-z0-9._/-]*$/;
const approvalBoundaries = new Set(["none", "conditional", "required"]);

function asObject(value: JsonValue | undefined, label: string): ProcedureMetadataObject {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${label} must be an object`);
  return value;
}

function asBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function strings(
  value: JsonValue | undefined,
  label: string,
  options: { minItems?: number; unique?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${label} must be an array of strings`);
  const result = value as string[];
  if (result.some((entry) => entry.trim() === ""))
    throw new Error(`${label} must not contain empty strings`);
  if (result.length < (options.minItems ?? 0))
    throw new Error(`${label} must contain at least ${options.minItems} item${options.minItems === 1 ? "" : "s"}`);
  if (options.unique && new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`);
  return result;
}

function exactKeys(object: ProcedureMetadataObject, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
  const missing = allowed.filter((key) => !(key in object));
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

function artifactIds(value: JsonValue | undefined, label: string): string[] {
  const result = strings(value, label, { unique: true });
  for (const artifact of result)
    if (!artifactIdPattern.test(artifact))
      throw new Error(`${label} contains invalid artifact ID ${artifact}`);
  return result;
}

export function normalizeAgentProcedureMetadata(
  value: ProcedureMetadataObject,
  label: string,
): ProcedureMetadataObject {
  exactKeys(value, ["routing", "termination", "artifacts"], label);

  const routing = asObject(value.routing, `${label}.routing`);
  exactKeys(
    routing,
    ["useWhen", "doNotUseWhen", "mutates", "approvalBoundary"],
    `${label}.routing`,
  );
  const approvalBoundary = asString(
    routing.approvalBoundary,
    `${label}.routing.approvalBoundary`,
  );
  if (!approvalBoundaries.has(approvalBoundary))
    throw new Error(`${label}.routing.approvalBoundary must be none, conditional, or required`);

  const termination = asObject(value.termination, `${label}.termination`);
  exactKeys(
    termination,
    [
      "terminal",
      "doneWhen",
      "stopWithoutChangeWhen",
      "escalateWhen",
      "evidenceRequired",
      "outOfScope",
    ],
    `${label}.termination`,
  );

  const artifacts = asObject(value.artifacts, `${label}.artifacts`);
  exactKeys(artifacts, ["consumes", "produces"], `${label}.artifacts`);

  return {
    routing: {
      useWhen: strings(routing.useWhen, `${label}.routing.useWhen`, { minItems: 1 }),
      doNotUseWhen: strings(routing.doNotUseWhen, `${label}.routing.doNotUseWhen`),
      mutates: asBoolean(routing.mutates, `${label}.routing.mutates`),
      approvalBoundary,
    },
    termination: {
      terminal: asBoolean(termination.terminal, `${label}.termination.terminal`),
      doneWhen: strings(termination.doneWhen, `${label}.termination.doneWhen`, { minItems: 1 }),
      stopWithoutChangeWhen: strings(
        termination.stopWithoutChangeWhen,
        `${label}.termination.stopWithoutChangeWhen`,
      ),
      escalateWhen: strings(termination.escalateWhen, `${label}.termination.escalateWhen`),
      evidenceRequired: strings(
        termination.evidenceRequired,
        `${label}.termination.evidenceRequired`,
        { minItems: 1 },
      ),
      outOfScope: strings(termination.outOfScope, `${label}.termination.outOfScope`),
    },
    artifacts: {
      consumes: artifactIds(artifacts.consumes, `${label}.artifacts.consumes`),
      produces: artifactIds(artifacts.produces, `${label}.artifacts.produces`),
    },
  };
}
