import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { planGenerator, type GeneratorPlan, type PlannedGeneratorOperation } from "./generators.ts";
import type { ResultEnvelope } from "./model.ts";

type GenerationResultKind = "generated" | "no-op" | "generation-conflict" | "generation-failed";

export type GenerationApplyResult = {
  result: GenerationResultKind;
  created: string[];
  changed: string[];
  noOp: string[];
  rolledBack: string[];
  diagnostics: Array<{ code: string; message: string; path?: string }>;
};

type PreparedMutation = {
  operation: PlannedGeneratorOperation;
  absolutePath: string;
  desiredContent: string;
  previousContent?: string;
  outcome: "create" | "change" | "no-op";
};

export type GeneratorApplyOptions = {
  writeFile?: (path: string, content: string) => void;
};

class GenerationConflict extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function outputPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (!withinRoot(absoluteRoot, absolute)) {
    throw new GenerationConflict(path, `Generated path escapes repository root: ${path}`);
  }
  return absolute;
}

function assertWritableParent(root: string, path: string): void {
  const absoluteRoot = resolve(root);
  let current = dirname(path);
  while (withinRoot(absoluteRoot, current) && current !== absoluteRoot) {
    if (existsSync(current) && !statSync(current).isDirectory()) {
      throw new GenerationConflict(path, `Generated path has a non-directory parent: ${current}`);
    }
    current = dirname(current);
  }
}

function createFileMutation(root: string, operation: PlannedGeneratorOperation): PreparedMutation {
  if (operation.kind !== "create-file") {
    throw new Error(`Expected create-file operation, received ${operation.kind}`);
  }
  const absolutePath = outputPath(root, operation.path);
  assertWritableParent(root, absolutePath);
  if (!existsSync(absolutePath)) {
    return {
      operation,
      absolutePath,
      desiredContent: operation.content,
      outcome: "create",
    };
  }
  if (!statSync(absolutePath).isFile()) {
    throw new GenerationConflict(operation.path, `Generated path is not a file: ${operation.path}`);
  }
  const previousContent = readFileSync(absolutePath, "utf8");
  if (previousContent === operation.content) {
    return {
      operation,
      absolutePath,
      desiredContent: operation.content,
      previousContent,
      outcome: "no-op",
    };
  }
  throw new GenerationConflict(
    operation.path,
    `Generated file already exists with different content: ${operation.path}`,
  );
}

function jsonSetMutation(root: string, operation: PlannedGeneratorOperation): PreparedMutation {
  if (operation.kind !== "json-set") {
    throw new Error(`Expected json-set operation, received ${operation.kind}`);
  }
  const absolutePath = outputPath(root, operation.path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new GenerationConflict(
      operation.path,
      `Structured update target must be an existing JSON file: ${operation.path}`,
    );
  }
  const previousContent = readFileSync(absolutePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(previousContent);
  } catch {
    throw new GenerationConflict(operation.path, `Structured update target is invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GenerationConflict(operation.path, `Structured update target must contain an object`);
  }

  const segments = operation.key.split(".");
  let cursor = parsed as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new GenerationConflict(
        operation.path,
        `Structured update parent does not exist as an object: ${operation.key}`,
      );
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  if (Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    if (cursor[leaf] === operation.value) {
      return {
        operation,
        absolutePath,
        desiredContent: previousContent,
        previousContent,
        outcome: "no-op",
      };
    }
    throw new GenerationConflict(
      operation.path,
      `Structured update would replace an existing value at ${operation.key}`,
    );
  }
  cursor[leaf] = operation.value;
  return {
    operation,
    absolutePath,
    desiredContent: `${JSON.stringify(parsed, null, 2)}\n`,
    previousContent,
    outcome: "change",
  };
}

function typescriptBarrelExportMutation(
  root: string,
  operation: PlannedGeneratorOperation,
): PreparedMutation {
  if (operation.kind !== "typescript-barrel-export") {
    throw new Error(`Expected typescript-barrel-export operation, received ${operation.kind}`);
  }
  const absolutePath = outputPath(root, operation.path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new GenerationConflict(
      operation.path,
      `TypeScript barrel update target must be an existing file: ${operation.path}`,
    );
  }

  const previousContent = readFileSync(absolutePath, "utf8");
  const lines = previousContent.split("\n");
  while (lines.at(-1) === "") lines.pop();

  let index = 0;
  let useClient = false;
  if (lines[0] === '"use client";') {
    useClient = true;
    index = 1;
  }

  const modules: string[] = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "") continue;
    const match = /^export \* from "([^"\n]+)";$/.exec(line);
    if (!match) {
      throw new GenerationConflict(
        operation.path,
        `TypeScript barrel contains unsupported content: ${operation.path}`,
      );
    }
    modules.push(match[1]!);
  }

  if (new Set(modules).size !== modules.length) {
    throw new GenerationConflict(
      operation.path,
      `TypeScript barrel contains duplicate exports: ${operation.path}`,
    );
  }
  if (modules.includes(operation.module)) {
    return {
      operation,
      absolutePath,
      desiredContent: previousContent,
      previousContent,
      outcome: "no-op",
    };
  }

  const insertionIndex = modules.findIndex((module) => module.localeCompare(operation.module) > 0);
  const nextModules = [...modules];
  nextModules.splice(
    insertionIndex === -1 ? nextModules.length : insertionIndex,
    0,
    operation.module,
  );
  const exports = nextModules.map((module) => `export * from "${module}";`).join("\n");
  const desiredContent = useClient ? `"use client";\n\n${exports}\n` : `${exports}\n`;
  return {
    operation,
    absolutePath,
    desiredContent,
    previousContent,
    outcome: "change",
  };
}

function prepareMutation(root: string, operation: PlannedGeneratorOperation): PreparedMutation {
  if (operation.kind === "create-file") return createFileMutation(root, operation);
  if (operation.kind === "json-set") return jsonSetMutation(root, operation);
  if (operation.kind === "typescript-barrel-export")
    return typescriptBarrelExportMutation(root, operation);
  const exhaustive: never = operation;
  throw new Error(`Unsupported planned generator operation: ${String(exhaustive)}`);
}

function failureResult(
  result: "generation-conflict" | "generation-failed",
  code: string,
  message: string,
  path?: string,
  rolledBack: string[] = [],
): GenerationApplyResult {
  return {
    result,
    created: [],
    changed: [],
    noOp: [],
    rolledBack,
    diagnostics: [{ code, message, path }],
  };
}

export function applyGeneratorPlan(
  root: string,
  plan: GeneratorPlan,
  options: GeneratorApplyOptions = {},
): GenerationApplyResult {
  let prepared: PreparedMutation[];
  try {
    prepared = plan.operations.map((operation) => prepareMutation(root, operation));
  } catch (error) {
    if (error instanceof GenerationConflict) {
      return failureResult("generation-conflict", "generation-conflict", error.message, error.path);
    }
    return failureResult(
      "generation-failed",
      "generation-failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const writes = prepared.filter((mutation) => mutation.outcome !== "no-op");
  if (writes.length === 0) {
    return {
      result: "no-op",
      created: [],
      changed: [],
      noOp: prepared.map((mutation) => mutation.operation.path),
      rolledBack: [],
      diagnostics: [],
    };
  }

  const writeFile =
    options.writeFile ?? ((path: string, content: string) => writeFileSync(path, content));
  const touched: PreparedMutation[] = [];
  try {
    for (const mutation of writes) {
      mkdirSync(dirname(mutation.absolutePath), { recursive: true });
      writeFile(mutation.absolutePath, mutation.desiredContent);
      touched.push(mutation);
    }
  } catch (error) {
    const rolledBack: string[] = [];
    for (const mutation of [...touched].reverse()) {
      try {
        if (mutation.previousContent === undefined) rmSync(mutation.absolutePath, { force: true });
        else writeFileSync(mutation.absolutePath, mutation.previousContent);
        rolledBack.push(mutation.operation.path);
      } catch {
        // Continue restoring later mutations; the primary result still reports failure.
      }
    }
    return failureResult(
      "generation-failed",
      "generation-failed",
      error instanceof Error ? error.message : String(error),
      undefined,
      rolledBack,
    );
  }

  return {
    result: "generated",
    created: prepared
      .filter((mutation) => mutation.outcome === "create")
      .map((mutation) => mutation.operation.path),
    changed: prepared
      .filter((mutation) => mutation.outcome === "change")
      .map((mutation) => mutation.operation.path),
    noOp: prepared
      .filter((mutation) => mutation.outcome === "no-op")
      .map((mutation) => mutation.operation.path),
    rolledBack: [],
    diagnostics: [],
  };
}

export function applyGeneratorCommand(
  root: string,
  id: string,
  rawInputs: Record<string, string>,
  explicitTarget?: string,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  try {
    const plan = planGenerator(root, id, rawInputs, explicitTarget);
    const generation = applyGeneratorPlan(root, plan);
    const passed = generation.result === "generated" || generation.result === "no-op";
    return {
      schemaVersion: 1,
      operation: "generate",
      status: passed ? "passed" : "failed",
      durationMs: Date.now() - started,
      data: { plan, generation },
      diagnostics: generation.diagnostics,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "generate",
      status: "failed",
      durationMs: Date.now() - started,
      data: {},
      diagnostics: [
        {
          code: "generation-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
