import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { capabilities, type Capability, type ResultEnvelope } from "./model.ts";
import { readJson, walkFiles } from "./shared.ts";

type GeneratorInputType = "string" | "boolean" | "enum" | "identifier" | "path";

type GeneratorInput = {
  type: GeneratorInputType;
  required?: boolean;
  default?: string | boolean;
  values?: string[];
};

type GeneratorTarget = { kind: "root" } | { kind: "concept"; concept: string };

type CreateFileOperation = {
  kind: "create-file";
  template: string;
  path: string;
};

type GeneratorComposition = {
  generator: string;
  inputs?: Record<string, string>;
};

type GeneratorPrerequisite = {
  kind: string;
  [key: string]: unknown;
};

export type GeneratorDescriptor = {
  schemaVersion: 1;
  id: string;
  description: string;
  rules: string[];
  technologies: string[];
  inputs: Record<string, GeneratorInput>;
  target: GeneratorTarget;
  operations: CreateFileOperation[];
  compose: GeneratorComposition[];
  prerequisites: GeneratorPrerequisite[];
  postconditions: Capability[];
};

export type GeneratorCatalogEntry = {
  id: string;
  description: string;
  source: "convention" | "local";
  module?: string;
  path: string;
  rules: string[];
  technologies: string[];
  inputs: Record<string, GeneratorInput>;
  target: GeneratorTarget;
  prerequisites: GeneratorPrerequisite[];
  postconditions: Capability[];
  composedGenerators: string[];
};

export type PlannedGeneratorOperation = {
  generator: string;
  kind: "create-file";
  path: string;
  template: string;
};

export type GeneratorPlan = {
  generator: string;
  inputs: Record<string, string | boolean>;
  target: string;
  operations: PlannedGeneratorOperation[];
  prerequisites: GeneratorPrerequisite[];
  postconditions: Capability[];
};

type LoadedGenerator = {
  descriptor: GeneratorDescriptor;
  source: "convention" | "local";
  module?: string;
  descriptorPath: string;
  directory: string;
};

type GeneratorConfig = {
  generatorTargets?: Record<string, string | string[]>;
};

const generatorIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const inputNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ruleIdPattern = /^[A-Z][A-Z0-9-]*-\d+$/;
const allowedTransforms = new Set(["pascal", "camel", "kebab", "snake"]);

class GeneratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function managedPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safePath(root: string, candidate: string, code: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, candidate);
  if (!withinRoot(absoluteRoot, absolute)) {
    throw new GeneratorError(code, `Path escapes repository root: ${candidate}`);
  }
  return absolute;
}

function validateInterpolation(value: string, inputNames: ReadonlySet<string>): void {
  for (const match of value.matchAll(/{{(.*?)}}/gs)) {
    const expression = match[1]?.trim() ?? "";
    const pieces = expression.split("|").map((piece) => piece.trim());
    const name = pieces[0];
    const transform = pieces[1];
    if (
      pieces.length > 2 ||
      !name ||
      !inputNames.has(name) ||
      (transform !== undefined && !allowedTransforms.has(transform))
    ) {
      throw new GeneratorError(
        "unsupported-template-expression",
        `Unsupported generator interpolation: {{${expression}}}`,
      );
    }
  }
}

function parseInput(value: unknown, generatorId: string, name: string): GeneratorInput {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new GeneratorError(
      "invalid-generator",
      `Generator ${generatorId} has invalid input ${name}`,
    );
  }
  const type = value.type;
  if (!["string", "boolean", "enum", "identifier", "path"].includes(type)) {
    throw new GeneratorError(
      "invalid-generator",
      `Generator ${generatorId} input ${name} uses unsupported type ${type}`,
    );
  }
  const values = value.values;
  if (
    type === "enum" &&
    (!Array.isArray(values) ||
      values.length === 0 ||
      !values.every((item) => typeof item === "string"))
  ) {
    throw new GeneratorError(
      "invalid-generator",
      `Generator ${generatorId} enum ${name} needs values`,
    );
  }
  return {
    type: type as GeneratorInputType,
    required: value.required === true,
    default:
      typeof value.default === "string" || typeof value.default === "boolean"
        ? value.default
        : undefined,
    values: type === "enum" ? (values as string[]) : undefined,
  };
}

function parseDescriptor(path: string): GeneratorDescriptor {
  const value = readJson<unknown>(path);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !generatorIdPattern.test(value.id) ||
    typeof value.description !== "string" ||
    !value.description.trim() ||
    !isRecord(value.inputs) ||
    !isRecord(value.target) ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.compose) ||
    !Array.isArray(value.prerequisites) ||
    !Array.isArray(value.postconditions) ||
    !Array.isArray(value.rules) ||
    !Array.isArray(value.technologies)
  ) {
    throw new GeneratorError("invalid-generator", `Invalid generator descriptor: ${path}`);
  }

  const rules = value.rules;
  if (!rules.every((rule) => typeof rule === "string" && ruleIdPattern.test(rule))) {
    throw new GeneratorError(
      "invalid-generator",
      `Generator ${value.id} has invalid rule references`,
    );
  }
  const technologies = value.technologies;
  if (
    !technologies.every((technology) => typeof technology === "string" && technology.length > 0)
  ) {
    throw new GeneratorError("invalid-generator", `Generator ${value.id} has invalid technologies`);
  }

  const inputs: Record<string, GeneratorInput> = {};
  for (const [name, input] of Object.entries(value.inputs)) {
    if (!inputNamePattern.test(name)) {
      throw new GeneratorError(
        "invalid-generator",
        `Generator ${value.id} has invalid input name ${name}`,
      );
    }
    inputs[name] = parseInput(input, value.id, name);
  }
  const inputNames = new Set(Object.keys(inputs));

  let target: GeneratorTarget;
  if (value.target.kind === "root") target = { kind: "root" };
  else if (
    value.target.kind === "concept" &&
    typeof value.target.concept === "string" &&
    generatorIdPattern.test(value.target.concept)
  ) {
    target = { kind: "concept", concept: value.target.concept };
  } else {
    throw new GeneratorError(
      "invalid-generator",
      `Generator ${value.id} has invalid target metadata`,
    );
  }

  const operations: CreateFileOperation[] = value.operations.map((operation) => {
    if (
      !isRecord(operation) ||
      operation.kind !== "create-file" ||
      typeof operation.template !== "string" ||
      !managedPath(operation.template) ||
      typeof operation.path !== "string" ||
      !operation.path
    ) {
      throw new GeneratorError(
        "invalid-generator",
        `Generator ${value.id} contains an unsupported operation`,
      );
    }
    validateInterpolation(operation.path, inputNames);
    return { kind: "create-file", template: operation.template, path: operation.path };
  });

  const compose: GeneratorComposition[] = value.compose.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.generator !== "string" ||
      !generatorIdPattern.test(item.generator)
    ) {
      throw new GeneratorError(
        "invalid-generator",
        `Generator ${value.id} has invalid composition`,
      );
    }
    const mapping: Record<string, string> = {};
    if (item.inputs !== undefined) {
      if (!isRecord(item.inputs)) {
        throw new GeneratorError(
          "invalid-generator",
          `Generator ${value.id} has invalid input mapping`,
        );
      }
      for (const [name, expression] of Object.entries(item.inputs)) {
        if (!inputNamePattern.test(name) || typeof expression !== "string") {
          throw new GeneratorError(
            "invalid-generator",
            `Generator ${value.id} has invalid input mapping`,
          );
        }
        validateInterpolation(expression, inputNames);
        mapping[name] = expression;
      }
    }
    return { generator: item.generator, inputs: mapping };
  });

  const prerequisites = value.prerequisites.map((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || !item.kind) {
      throw new GeneratorError(
        "invalid-generator",
        `Generator ${value.id} has invalid prerequisite`,
      );
    }
    return item as GeneratorPrerequisite;
  });

  const postconditions = value.postconditions.map((item) => {
    if (typeof item !== "string" || !capabilities.includes(item as Capability)) {
      throw new GeneratorError(
        "invalid-generator",
        `Generator ${value.id} has invalid postcondition`,
      );
    }
    return item as Capability;
  });

  return {
    schemaVersion: 1,
    id: value.id,
    description: value.description,
    rules: rules as string[],
    technologies: technologies as string[],
    inputs,
    target,
    operations,
    compose,
    prerequisites,
    postconditions,
  };
}

function conventionGenerators(root: string): LoadedGenerator[] {
  const modulesRoot = join(root, ".conventions", "modules");
  if (!existsSync(modulesRoot)) return [];
  const result: LoadedGenerator[] = [];
  for (const path of walkFiles(modulesRoot, 16).sort()) {
    if (!path.endsWith(`${sep}generator.json`) || !path.includes(`${sep}generators${sep}`))
      continue;
    const relativePath = relative(modulesRoot, path);
    const module = relativePath.split(sep)[0];
    if (!module) continue;
    result.push({
      descriptor: parseDescriptor(path),
      source: "convention",
      module,
      descriptorPath: path,
      directory: dirname(path),
    });
  }
  return result;
}

function localGenerators(root: string): LoadedGenerator[] {
  const generatorsRoot = join(root, ".coding-tooling", "generators");
  if (!existsSync(generatorsRoot)) return [];
  const result: LoadedGenerator[] = [];
  for (const entry of readdirSync(generatorsRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || !generatorIdPattern.test(entry.name)) continue;
    const directory = join(generatorsRoot, entry.name);
    const descriptorPath = join(directory, "generator.json");
    if (!existsSync(descriptorPath) || !statSync(descriptorPath).isFile()) continue;
    const realDirectory = realpathSync(directory);
    const realRoot = realpathSync(generatorsRoot);
    if (!withinRoot(realRoot, realDirectory)) {
      throw new GeneratorError(
        "invalid-generator-path",
        `Local generator escapes generator root: ${entry.name}`,
      );
    }
    result.push({
      descriptor: parseDescriptor(descriptorPath),
      source: "local",
      descriptorPath,
      directory,
    });
  }
  return result;
}

function discover(root: string): Map<string, LoadedGenerator> {
  const catalog = new Map<string, LoadedGenerator>();
  for (const generator of [...conventionGenerators(root), ...localGenerators(root)]) {
    const id = generator.descriptor.id;
    if (catalog.has(id)) {
      throw new GeneratorError(
        "generator-id-conflict",
        `Generator ID is defined more than once: ${id}`,
      );
    }
    catalog.set(id, generator);
  }
  validateComposition(catalog);
  return catalog;
}

function validateComposition(catalog: Map<string, LoadedGenerator>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new GeneratorError(
        "generator-composition-cycle",
        `Generator composition cycle at ${id}`,
      );
    }
    if (visited.has(id)) return;
    const generator = catalog.get(id);
    if (!generator) {
      throw new GeneratorError("unknown-composed-generator", `Unknown composed generator: ${id}`);
    }
    visiting.add(id);
    for (const child of generator.descriptor.compose) {
      if (!catalog.has(child.generator)) {
        throw new GeneratorError(
          "unknown-composed-generator",
          `Generator ${id} composes unknown generator ${child.generator}`,
        );
      }
      visit(child.generator);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of catalog.keys()) visit(id);
}

function catalogEntry(root: string, generator: LoadedGenerator): GeneratorCatalogEntry {
  return {
    id: generator.descriptor.id,
    description: generator.descriptor.description,
    source: generator.source,
    module: generator.module,
    path: relative(root, generator.descriptorPath).split(sep).join("/"),
    rules: generator.descriptor.rules,
    technologies: generator.descriptor.technologies,
    inputs: generator.descriptor.inputs,
    target: generator.descriptor.target,
    prerequisites: generator.descriptor.prerequisites,
    postconditions: generator.descriptor.postconditions,
    composedGenerators: generator.descriptor.compose.map((item) => item.generator),
  };
}

function normalizeInput(
  generatorId: string,
  name: string,
  descriptor: GeneratorInput,
  raw: string | undefined,
): string | boolean | undefined {
  if (raw === undefined) {
    if (descriptor.default !== undefined) return descriptor.default;
    if (descriptor.required) {
      throw new GeneratorError(
        "missing-generator-input",
        `Generator ${generatorId} requires input ${name}`,
      );
    }
    return undefined;
  }
  if (descriptor.type === "boolean") {
    if (raw !== "true" && raw !== "false") {
      throw new GeneratorError(
        "invalid-generator-input",
        `Generator ${generatorId} input ${name} must be boolean`,
      );
    }
    return raw === "true";
  }
  if (descriptor.type === "enum" && !descriptor.values?.includes(raw)) {
    throw new GeneratorError(
      "invalid-generator-input",
      `Generator ${generatorId} input ${name} is not an allowed value`,
    );
  }
  if (descriptor.type === "identifier" && !identifierPattern.test(raw)) {
    throw new GeneratorError(
      "invalid-generator-input",
      `Generator ${generatorId} input ${name} is not an identifier`,
    );
  }
  if (descriptor.type === "path" && !managedPath(raw)) {
    throw new GeneratorError(
      "invalid-generator-input",
      `Generator ${generatorId} input ${name} is not a managed path`,
    );
  }
  return raw;
}

function resolveInputs(
  descriptor: GeneratorDescriptor,
  rawInputs: Record<string, string>,
): Record<string, string | boolean> {
  for (const name of Object.keys(rawInputs)) {
    if (!descriptor.inputs[name]) {
      throw new GeneratorError(
        "unknown-generator-input",
        `Generator ${descriptor.id} does not declare input ${name}`,
      );
    }
  }
  const result: Record<string, string | boolean> = {};
  for (const [name, input] of Object.entries(descriptor.inputs)) {
    const value = normalizeInput(descriptor.id, name, input, rawInputs[name]);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

function transform(value: string, kind: string | undefined): string {
  if (!kind) return value;
  const parts = words(value);
  if (kind === "kebab") return parts.join("-");
  if (kind === "snake") return parts.join("_");
  if (kind === "camel")
    return parts
      .map((part, index) =>
        index === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
      )
      .join("");
  if (kind === "pascal")
    return parts.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
  throw new GeneratorError("unsupported-template-expression", `Unsupported transform: ${kind}`);
}

function render(value: string, inputs: Record<string, string | boolean>): string {
  return value.replace(/{{(.*?)}}/gs, (_match, rawExpression: string) => {
    const [rawName, rawTransform] = rawExpression.split("|").map((piece) => piece.trim());
    const input = inputs[rawName ?? ""];
    if (input === undefined) {
      throw new GeneratorError(
        "missing-generator-input",
        `No value for generator input ${rawName}`,
      );
    }
    return transform(String(input), rawTransform);
  });
}

function targetCandidates(root: string, concept: string): string[] {
  const config = readJson<GeneratorConfig>(join(root, ".coding-tooling.json"));
  const configured = config?.generatorTargets?.[concept];
  const values =
    typeof configured === "string" ? [configured] : Array.isArray(configured) ? configured : [];
  return values.map((candidate) => safePath(root, candidate, "invalid-generator-target"));
}

function resolveTarget(root: string, target: GeneratorTarget, explicitTarget?: string): string {
  if (explicitTarget) return safePath(root, explicitTarget, "invalid-generator-target");
  if (target.kind === "root") return resolve(root);
  const candidates = targetCandidates(root, target.concept);
  if (candidates.length !== 1) {
    throw new GeneratorError(
      "target-required",
      `Generator target ${target.concept} resolved to ${candidates.length} locations; provide --target`,
    );
  }
  return candidates[0]!;
}

function templatePath(generator: LoadedGenerator, path: string): string {
  const candidate = resolve(generator.directory, path);
  const directory = resolve(generator.directory);
  if (
    !withinRoot(directory, candidate) ||
    !existsSync(candidate) ||
    !statSync(candidate).isFile()
  ) {
    throw new GeneratorError(
      "invalid-generator-template",
      `Generator template is unavailable: ${path}`,
    );
  }
  return candidate;
}

function mappedInputs(
  parent: Record<string, string | boolean>,
  mapping: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, expression] of Object.entries(mapping ?? {})) {
    result[name] = render(expression, parent);
  }
  return result;
}

function uniquePrerequisites(values: GeneratorPrerequisite[]): GeneratorPrerequisite[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function generatorCatalog(root: string): GeneratorCatalogEntry[] {
  return [...discover(root).values()]
    .map((generator) => catalogEntry(root, generator))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function planGenerator(
  root: string,
  id: string,
  rawInputs: Record<string, string>,
  explicitTarget?: string,
): GeneratorPlan {
  const catalog = discover(root);
  const generator = catalog.get(id);
  if (!generator) throw new GeneratorError("unknown-generator", `Unknown generator: ${id}`);
  const topInputs = resolveInputs(generator.descriptor, rawInputs);
  const target = resolveTarget(root, generator.descriptor.target, explicitTarget);
  const operations: PlannedGeneratorOperation[] = [];
  const prerequisites: GeneratorPrerequisite[] = [];
  const postconditions: Capability[] = [];

  const append = (current: LoadedGenerator, inputs: Record<string, string | boolean>): void => {
    prerequisites.push(...current.descriptor.prerequisites);
    postconditions.push(...current.descriptor.postconditions);
    for (const operation of current.descriptor.operations) {
      const relativePath = render(operation.path, inputs);
      if (!managedPath(relativePath)) {
        throw new GeneratorError(
          "invalid-generator-output",
          `Generator ${current.descriptor.id} produced unsafe path ${relativePath}`,
        );
      }
      const output = safePath(target, relativePath, "invalid-generator-output");
      operations.push({
        generator: current.descriptor.id,
        kind: "create-file",
        path: relative(root, output).split(sep).join("/"),
        template: relative(root, templatePath(current, operation.template)).split(sep).join("/"),
      });
    }
    for (const composition of current.descriptor.compose) {
      const child = catalog.get(composition.generator)!;
      const childInputs = resolveInputs(child.descriptor, mappedInputs(inputs, composition.inputs));
      append(child, childInputs);
    }
  };

  append(generator, topInputs);
  const seenPaths = new Set<string>();
  for (const operation of operations) {
    if (seenPaths.has(operation.path)) {
      throw new GeneratorError(
        "generation-plan-conflict",
        `Multiple generator operations target ${operation.path}`,
      );
    }
    seenPaths.add(operation.path);
  }

  return {
    generator: id,
    inputs: topInputs,
    target: relative(root, target).split(sep).join("/") || ".",
    operations,
    prerequisites: uniquePrerequisites(prerequisites),
    postconditions: [...new Set(postconditions)],
  };
}

function envelope(
  started: number,
  status: ResultEnvelope<Record<string, unknown>>["status"],
  data: Record<string, unknown>,
  diagnostics: Array<{ code?: string; message: string }> = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "generate",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function generatorCommand(
  root: string,
  action: "list" | "describe" | "plan",
  id?: string,
  rawInputs: Record<string, string> = {},
  explicitTarget?: string,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  try {
    if (action === "list")
      return envelope(started, "passed", { generators: generatorCatalog(root) });
    if (!id)
      throw new GeneratorError("generator-required", `Generator ID is required for ${action}`);
    if (action === "describe") {
      const entry = generatorCatalog(root).find((item) => item.id === id);
      if (!entry) throw new GeneratorError("unknown-generator", `Unknown generator: ${id}`);
      return envelope(started, "passed", { generator: entry });
    }
    return envelope(started, "passed", {
      plan: planGenerator(root, id, rawInputs, explicitTarget),
    });
  } catch (error) {
    const generatorError = error instanceof GeneratorError ? error : undefined;
    return envelope(started, "failed", {}, [
      {
        code: generatorError?.code ?? "generator-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
