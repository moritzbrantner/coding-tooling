import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ResultEnvelope } from "./model.ts";
import { runCommand } from "./shared.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type AgentCapabilityKind = "skill" | "flow";
export type AgentCapabilityMaturity = "stable" | "provisional";

export type ReadinessPredicate =
  | { predicate: "path-configured" | "path-exists"; key: string }
  | { predicate: "capability-available"; capability: string }
  | { predicate: "action-available"; action: string }
  | { predicate: "artifact-available"; artifact: string }
  | { predicate: "tool-available"; tool: string };

export type FlowStep =
  | {
      id: string;
      kind: "invoke";
      capability: string;
      inputs?: Record<string, string>;
      output?: string;
    }
  | { id: string; kind: "action"; action: string; optional?: boolean; fallback?: "skip" | "agent" }
  | { id: string; kind: "human-gate"; prompt: string }
  | { id: string; kind: "parallel"; steps: FlowStep[] }
  | {
      id: string;
      kind: "branch";
      condition: { source: string; equals: string | number | boolean | null };
      whenTrue: FlowStep[];
      whenFalse?: FlowStep[];
    };

export type AgentCapability = {
  id: string;
  name: string;
  kind: AgentCapabilityKind;
  maturity: AgentCapabilityMaturity;
  entryPoint: boolean;
  description?: string;
  intents: string[];
  requires: string[];
  relatedTo: string[];
  readiness: ReadinessPredicate[];
  flow?: { steps: FlowStep[] };
  extensions: Record<string, JsonObject>;
};

export type AgentCapabilityProfile = {
  name: string;
  extends?: string;
  capabilities: string[];
};

export type AgentCapabilityCatalogFragment = {
  schemaVersion: 1;
  namespace: string;
  revision: string;
  capabilities: AgentCapability[];
  profiles: AgentCapabilityProfile[];
};

const capabilityIdPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const namespacePattern = /^[a-z0-9][a-z0-9._-]*$/;
const namePattern = /^[a-z0-9][a-z0-9-]*$/;
const actionPattern = /^[a-z0-9][a-z0-9._-]*$/;

export const standardAgentActions = [
  "repository.format",
  "repository.verify",
  "scope.resolve",
  "vcs.commit",
] as const;

function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${label} must be an object`);
  return value;
}

function asString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function asBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  return value === undefined ? undefined : asString(value, label);
}

function parseScalar(value: string): JsonValue {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    return JSON.parse(trimmed) as JsonValue;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

type YamlLine = { indent: number; text: string };

function yamlLines(source: string): YamlLine[] {
  return source
    .split(/\r?\n/)
    .map((raw) => ({ raw, trimmed: raw.trim() }))
    .filter(({ trimmed }) => trimmed !== "" && !trimmed.startsWith("#"))
    .map(({ raw }) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }));
}

function splitKeyValue(text: string): [string, string] {
  const index = text.indexOf(":");
  if (index <= 0) throw new Error(`expected YAML key/value, got: ${text}`);
  return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
}

function parseYamlBlock(lines: YamlLine[], start: number, indent: number): [JsonValue, number] {
  if (lines[start]?.indent !== indent) throw new Error("invalid YAML indentation");
  return lines[start].text.startsWith("-")
    ? parseYamlSequence(lines, start, indent)
    : parseYamlMapping(lines, start, indent);
}

function parseYamlMapping(lines: YamlLine[], start: number, indent: number): [JsonValue, number] {
  const object: JsonObject = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`unexpected YAML indentation near: ${line.text}`);
    if (line.text.startsWith("-")) break;
    const [key, rawValue] = splitKeyValue(line.text);
    if (key in object) throw new Error(`duplicate YAML key: ${key}`);
    index += 1;
    if (rawValue !== "") {
      object[key] = parseScalar(rawValue);
      continue;
    }
    if (index >= lines.length || lines[index].indent <= indent) {
      object[key] = {};
      continue;
    }
    const [child, next] = parseYamlBlock(lines, index, lines[index].indent);
    object[key] = child;
    index = next;
  }
  return [object, index];
}

function parseYamlSequence(lines: YamlLine[], start: number, indent: number): [JsonValue, number] {
  const array: JsonValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith("-")) break;
    const rest = line.text.slice(1).trim();
    index += 1;
    if (rest === "") {
      if (index >= lines.length || lines[index].indent <= indent)
        throw new Error("empty YAML sequence item");
      const [child, next] = parseYamlBlock(lines, index, lines[index].indent);
      array.push(child);
      index = next;
      continue;
    }
    if (rest.includes(":")) {
      const [key, rawValue] = splitKeyValue(rest);
      const item: JsonObject = {};
      if (rawValue !== "") item[key] = parseScalar(rawValue);
      else if (index < lines.length && lines[index].indent > indent) {
        const [child, next] = parseYamlBlock(lines, index, lines[index].indent);
        item[key] = child;
        index = next;
      } else item[key] = {};

      if (index < lines.length && lines[index].indent > indent) {
        const [continuation, next] = parseYamlBlock(lines, index, lines[index].indent);
        const continuationObject = asObject(continuation, `sequence item after ${key}`);
        for (const [continuationKey, value] of Object.entries(continuationObject)) {
          if (continuationKey in item) throw new Error(`duplicate YAML key: ${continuationKey}`);
          item[continuationKey] = value;
        }
        index = next;
      }
      array.push(item);
      continue;
    }
    array.push(parseScalar(rest));
  }
  return [array, index];
}

function parseYamlSubset(source: string): JsonObject {
  const lines = yamlLines(source);
  if (lines.length === 0) return {};
  const [value, next] = parseYamlBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) throw new Error(`could not parse YAML near: ${lines[next].text}`);
  return asObject(value, "frontmatter");
}

function parseFrontmatter(path: string): JsonObject {
  const source = readFileSync(path, "utf8");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error(`${path}: missing opening frontmatter delimiter`);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error(`${path}: missing closing frontmatter delimiter`);
  return parseYamlSubset(lines.slice(1, end).join("\n"));
}

function unknownKeys(object: JsonObject, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function normalizeReadiness(value: JsonValue | undefined, label: string): ReadinessPredicate[] {
  if (!Array.isArray(value)) throw new Error(`${label}.readiness must be an array`);
  return value.map((entry, index) => {
    const object = asObject(entry, `${label}.readiness[${index}]`);
    const predicate = asString(object.predicate, `${label}.readiness[${index}].predicate`);
    if (predicate === "path-configured" || predicate === "path-exists") {
      unknownKeys(object, new Set(["predicate", "key"]), `${label}.readiness[${index}]`);
      return { predicate, key: asString(object.key, `${label}.readiness[${index}].key`) };
    }
    if (predicate === "capability-available") {
      unknownKeys(object, new Set(["predicate", "capability"]), `${label}.readiness[${index}]`);
      return {
        predicate,
        capability: asString(object.capability, `${label}.readiness[${index}].capability`),
      };
    }
    if (predicate === "action-available") {
      unknownKeys(object, new Set(["predicate", "action"]), `${label}.readiness[${index}]`);
      return { predicate, action: asString(object.action, `${label}.readiness[${index}].action`) };
    }
    if (predicate === "artifact-available") {
      unknownKeys(object, new Set(["predicate", "artifact"]), `${label}.readiness[${index}]`);
      return {
        predicate,
        artifact: asString(object.artifact, `${label}.readiness[${index}].artifact`),
      };
    }
    if (predicate === "tool-available") {
      unknownKeys(object, new Set(["predicate", "tool"]), `${label}.readiness[${index}]`);
      return { predicate, tool: asString(object.tool, `${label}.readiness[${index}].tool`) };
    }
    throw new Error(`${label}.readiness[${index}] has unsupported predicate ${predicate}`);
  });
}

function normalizeFlowStep(value: JsonValue, label: string): FlowStep {
  const object = asObject(value, label);
  const id = asString(object.id, `${label}.id`);
  const kind = asString(object.kind, `${label}.kind`);
  if (kind === "invoke") {
    unknownKeys(object, new Set(["id", "kind", "capability", "inputs", "output"]), label);
    const rawInputs = object.inputs;
    let inputs: Record<string, string> | undefined;
    if (rawInputs !== undefined) {
      const inputObject = asObject(rawInputs, `${label}.inputs`);
      inputs = Object.fromEntries(
        Object.entries(inputObject).map(([key, entry]) => [
          key,
          asString(entry, `${label}.inputs.${key}`),
        ]),
      );
    }
    return {
      id,
      kind,
      capability: asString(object.capability, `${label}.capability`),
      inputs,
      output: optionalString(object.output, `${label}.output`),
    };
  }
  if (kind === "action") {
    unknownKeys(object, new Set(["id", "kind", "action", "optional", "fallback"]), label);
    const optional =
      object.optional === undefined ? undefined : asBoolean(object.optional, `${label}.optional`);
    const fallback = optionalString(object.fallback, `${label}.fallback`);
    if (fallback !== undefined && fallback !== "skip" && fallback !== "agent") {
      throw new Error(`${label}.fallback must be skip or agent`);
    }
    return { id, kind, action: asString(object.action, `${label}.action`), optional, fallback };
  }
  if (kind === "human-gate") {
    unknownKeys(object, new Set(["id", "kind", "prompt"]), label);
    return { id, kind, prompt: asString(object.prompt, `${label}.prompt`) };
  }
  if (kind === "parallel") {
    unknownKeys(object, new Set(["id", "kind", "steps"]), label);
    if (!Array.isArray(object.steps)) throw new Error(`${label}.steps must be an array`);
    return {
      id,
      kind,
      steps: object.steps.map((step, index) => normalizeFlowStep(step, `${label}.steps[${index}]`)),
    };
  }
  if (kind === "branch") {
    unknownKeys(object, new Set(["id", "kind", "condition", "then", "else"]), label);
    const condition = asObject(object.condition, `${label}.condition`);
    unknownKeys(condition, new Set(["source", "equals"]), `${label}.condition`);
    const equals = condition.equals;
    if (equals !== null && !["string", "number", "boolean"].includes(typeof equals)) {
      throw new Error(`${label}.condition.equals must be a scalar`);
    }
    if (!Array.isArray(object.then)) throw new Error(`${label}.then must be an array`);
    if (object.else !== undefined && !Array.isArray(object.else))
      throw new Error(`${label}.else must be an array`);
    return {
      id,
      kind,
      condition: {
        source: asString(condition.source, `${label}.condition.source`),
        equals: equals as string | number | boolean | null,
      },
      whenTrue: object.then.map((step, index) =>
        normalizeFlowStep(step, `${label}.then[${index}]`),
      ),
      whenFalse: Array.isArray(object.else)
        ? object.else.map((step, index) => normalizeFlowStep(step, `${label}.else[${index}]`))
        : undefined,
    };
  }
  throw new Error(`${label}.kind has unsupported value ${kind}`);
}

function normalizeCapability(frontmatter: JsonObject, path: string): AgentCapability {
  unknownKeys(
    frontmatter,
    new Set([
      "id",
      "name",
      "description",
      "kind",
      "maturity",
      "entry-point",
      "intents",
      "requires",
      "related-to",
      "readiness",
      "flow",
      "extensions",
    ]),
    path,
  );
  const id = asString(frontmatter.id, `${path}.id`);
  const name = asString(frontmatter.name, `${path}.name`);
  const kind = asString(frontmatter.kind, `${path}.kind`);
  const maturity = asString(frontmatter.maturity, `${path}.maturity`);
  if (!capabilityIdPattern.test(id))
    throw new Error(`${path}.id must be a namespaced stable capability ID`);
  if (!namePattern.test(name)) throw new Error(`${path}.name must use kebab-case`);
  if (kind !== "skill" && kind !== "flow") throw new Error(`${path}.kind must be skill or flow`);
  if (maturity !== "stable" && maturity !== "provisional")
    throw new Error(`${path}.maturity must be stable or provisional`);

  const extensionsRaw =
    frontmatter.extensions === undefined
      ? {}
      : asObject(frontmatter.extensions, `${path}.extensions`);
  const extensions: Record<string, JsonObject> = {};
  for (const [namespace, value] of Object.entries(extensionsRaw)) {
    if (!namespacePattern.test(namespace))
      throw new Error(`${path}.extensions has invalid namespace ${namespace}`);
    extensions[namespace] = asObject(value, `${path}.extensions.${namespace}`);
  }

  let flow: { steps: FlowStep[] } | undefined;
  if (frontmatter.flow !== undefined) {
    if (kind !== "flow")
      throw new Error(`${path}: skill capabilities cannot declare flow composition`);
    const flowObject = asObject(frontmatter.flow, `${path}.flow`);
    unknownKeys(flowObject, new Set(["steps"]), `${path}.flow`);
    if (!Array.isArray(flowObject.steps) || flowObject.steps.length === 0)
      throw new Error(`${path}.flow.steps must be a non-empty array`);
    flow = {
      steps: flowObject.steps.map((step, index) =>
        normalizeFlowStep(step, `${path}.flow.steps[${index}]`),
      ),
    };
  } else if (kind === "flow")
    throw new Error(`${path}: flow capabilities require flow composition`);

  return {
    id,
    name,
    kind,
    maturity,
    entryPoint: asBoolean(frontmatter["entry-point"], `${path}.entry-point`),
    description: optionalString(frontmatter.description, `${path}.description`),
    intents: asStringArray(frontmatter.intents, `${path}.intents`),
    requires: asStringArray(frontmatter.requires, `${path}.requires`),
    relatedTo: asStringArray(frontmatter["related-to"], `${path}.related-to`),
    readiness: normalizeReadiness(frontmatter.readiness, path),
    flow,
    extensions,
  };
}

function parseProfile(path: string): AgentCapabilityProfile {
  const source = readFileSync(path, "utf8");
  const name = source.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const extendsName = source.match(/^extends\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const match = source.match(/capabilities\s*=\s*\[([\s\S]*?)\]/m);
  if (!name || !match) throw new Error(`${path}: profile requires name and capabilities`);
  const values = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const quoted = entry.match(/^"([^"]+)"$/);
      if (!quoted) throw new Error(`${path}: capabilities must be double-quoted strings`);
      return quoted[1];
    });
  return { name, extends: extendsName, capabilities: values };
}

function filesIn(root: string, directory: string, filename: string): string[] {
  const parent = join(root, directory);
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(parent, entry.name, filename)))
    .map((entry) => join(parent, entry.name, filename))
    .sort();
}

function detectedRevision(root: string): string {
  const head = runCommand("git", ["rev-parse", "HEAD"], root);
  if (head.status !== 0 || head.stdout.trim() === "") return "working-tree";
  const dirty = runCommand("git", ["status", "--porcelain"], root);
  return dirty.status === 0 && dirty.stdout.trim() !== ""
    ? `${head.stdout.trim()}-dirty`
    : head.stdout.trim();
}

function invokedCapabilities(steps: FlowStep[]): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (step.kind === "invoke") ids.push(step.capability);
    else if (step.kind === "parallel") ids.push(...invokedCapabilities(step.steps));
    else if (step.kind === "branch") {
      ids.push(...invokedCapabilities(step.whenTrue));
      if (step.whenFalse) ids.push(...invokedCapabilities(step.whenFalse));
    }
  }
  return ids;
}

function validateCatalog(catalog: AgentCapabilityCatalogFragment): void {
  if (!namespacePattern.test(catalog.namespace))
    throw new Error(`invalid catalog namespace ${catalog.namespace}`);
  const byId = new Map<string, AgentCapability>();
  const names = new Set<string>();
  for (const capability of catalog.capabilities) {
    if (byId.has(capability.id)) throw new Error(`duplicate capability ID ${capability.id}`);
    if (names.has(capability.name)) throw new Error(`duplicate capability name ${capability.name}`);
    if (!capability.id.startsWith(`${catalog.namespace}/`)) {
      throw new Error(
        `capability ${capability.id} does not belong to namespace ${catalog.namespace}`,
      );
    }
    byId.set(capability.id, capability);
    names.add(capability.name);
    for (const action of capability.readiness.filter(
      (entry) => entry.predicate === "action-available",
    )) {
      if (!actionPattern.test(action.action)) throw new Error(`invalid action ID ${action.action}`);
    }
    if (capability.flow) {
      const stepIds = new Set<string>();
      const visitSteps = (steps: FlowStep[]): void => {
        for (const step of steps) {
          if (stepIds.has(step.id))
            throw new Error(`${capability.id} has duplicate flow step ID ${step.id}`);
          stepIds.add(step.id);
          if (step.kind === "action") {
            if (!actionPattern.test(step.action))
              throw new Error(`${capability.id} has invalid action ID ${step.action}`);
            if (step.optional && !step.fallback)
              throw new Error(
                `${capability.id} optional action ${step.action} must declare fallback`,
              );
            if (!step.optional && step.fallback)
              throw new Error(
                `${capability.id} required action ${step.action} cannot declare fallback`,
              );
          } else if (step.kind === "parallel") visitSteps(step.steps);
          else if (step.kind === "branch") {
            visitSteps(step.whenTrue);
            if (step.whenFalse) visitSteps(step.whenFalse);
          }
        }
      };
      visitSteps(capability.flow.steps);
    }
  }

  const profileByName = new Map<string, AgentCapabilityProfile>();
  for (const profile of catalog.profiles) {
    if (profileByName.has(profile.name)) throw new Error(`duplicate profile ${profile.name}`);
    profileByName.set(profile.name, profile);
    for (const id of profile.capabilities) {
      const capability = byId.get(id);
      if (!capability)
        throw new Error(`profile ${profile.name} references missing capability ${id}`);
      if (!capability.entryPoint)
        throw new Error(`profile ${profile.name} cannot select internal capability ${id}`);
      if (capability.maturity !== "stable")
        throw new Error(`profile ${profile.name} cannot auto-enable provisional capability ${id}`);
    }
  }
  for (const profile of catalog.profiles)
    if (profile.extends && !profileByName.has(profile.extends))
      throw new Error(`profile ${profile.name} extends missing profile ${profile.extends}`);

  const flowEdges = new Map<string, string[]>();
  for (const capability of catalog.capabilities) {
    if (!capability.flow) continue;
    const localFlowTargets = invokedCapabilities(capability.flow.steps).filter(
      (id) => byId.get(id)?.kind === "flow",
    );
    flowEdges.set(capability.id, localFlowTargets);
    for (const invoked of invokedCapabilities(capability.flow.steps)) {
      if (invoked.startsWith(`${catalog.namespace}/`) && !byId.has(invoked))
        throw new Error(`${capability.id} invokes missing capability ${invoked}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`executable flow cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of flowEdges.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of flowEdges.keys()) visit(id);

  for (const profile of catalog.profiles) resolveAgentProfile(catalog, profile.name);
}

export function buildAgentCapabilityCatalog(
  root: string,
  revision = detectedRevision(root),
): AgentCapabilityCatalogFragment {
  const paths = [...filesIn(root, "skills", "SKILL.md"), ...filesIn(root, "flows", "FLOW.md")];
  if (paths.length === 0) throw new Error(`${root}: no skills/*/SKILL.md or flows/*/FLOW.md found`);
  const capabilities = paths.map((path) => normalizeCapability(parseFrontmatter(path), path));
  const namespaces = new Set(capabilities.map((capability) => capability.id.split("/", 1)[0]));
  if (namespaces.size !== 1)
    throw new Error(
      `catalog must contain exactly one capability namespace, got ${[...namespaces].join(", ")}`,
    );
  const profileRoot = join(root, "profiles");
  const profiles = existsSync(profileRoot)
    ? readdirSync(profileRoot)
        .filter((name) => name.endsWith(".toml"))
        .sort()
        .map((name) => parseProfile(join(profileRoot, name)))
    : [];
  const catalog: AgentCapabilityCatalogFragment = {
    schemaVersion: 1,
    namespace: [...namespaces][0],
    revision,
    capabilities,
    profiles,
  };
  validateCatalog(catalog);
  return catalog;
}

export function resolveAgentProfile(
  catalog: AgentCapabilityCatalogFragment,
  name: string,
): string[] {
  const byName = new Map(catalog.profiles.map((profile) => [profile.name, profile]));
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const visit = (profileName: string): void => {
    if (visiting.has(profileName))
      throw new Error(`profile inheritance cycle detected at ${profileName}`);
    const profile = byName.get(profileName);
    if (!profile) throw new Error(`unknown profile ${profileName}`);
    visiting.add(profileName);
    if (profile.extends) visit(profile.extends);
    for (const id of profile.capabilities) resolved.add(id);
    visiting.delete(profileName);
  };
  visit(name);
  return [...resolved];
}

export function mergeAgentCapabilityCatalogs(
  fragments: AgentCapabilityCatalogFragment[],
): AgentCapabilityCatalogFragment[] {
  const ids = new Set<string>();
  for (const fragment of fragments) {
    validateCatalog(fragment);
    for (const capability of fragment.capabilities) {
      if (ids.has(capability.id))
        throw new Error(`duplicate federated capability ID ${capability.id}`);
      ids.add(capability.id);
    }
  }
  for (const fragment of fragments) {
    for (const capability of fragment.capabilities) {
      for (const required of capability.requires)
        if (!ids.has(required))
          throw new Error(`${capability.id} requires unavailable capability ${required}`);
      if (capability.flow)
        for (const invoked of invokedCapabilities(capability.flow.steps))
          if (!ids.has(invoked))
            throw new Error(`${capability.id} invokes unavailable capability ${invoked}`);
    }
  }
  return fragments;
}

export function resolveFederatedProfile(
  fragments: AgentCapabilityCatalogFragment[],
  name: string,
): string[] {
  mergeAgentCapabilityCatalogs(fragments);
  return [
    ...new Set(
      fragments
        .filter((fragment) => fragment.profiles.some((profile) => profile.name === name))
        .flatMap((fragment) => resolveAgentProfile(fragment, name)),
    ),
  ];
}

export function agentCapabilitiesCommand(
  root: string,
  action: string,
  profile?: string,
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  try {
    const catalog = buildAgentCapabilityCatalog(root);
    const data: Record<string, unknown> =
      action === "catalog"
        ? { catalog }
        : action === "validate"
          ? {
              namespace: catalog.namespace,
              revision: catalog.revision,
              capabilities: catalog.capabilities.length,
              profiles: catalog.profiles.length,
            }
          : action === "profile" && profile
            ? { profile, capabilities: resolveAgentProfile(catalog, profile) }
            : (() => {
                throw new Error(
                  "expected agent-capabilities action: validate, catalog, or profile <name>",
                );
              })();
    return {
      schemaVersion: 1,
      operation: "agent-capabilities",
      status: "passed",
      durationMs: Math.round(performance.now() - started),
      data,
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "agent-capabilities",
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      data: {},
      diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
