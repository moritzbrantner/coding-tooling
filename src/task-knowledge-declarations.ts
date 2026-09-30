import { isAbsolute } from "node:path";

import { capabilities, type Capability } from "./model.ts";

export type TaskReference = { path: string; entrypoint?: string };
export type TaskScope = {
  id: string;
  paths: string[];
  taskKinds?: string[];
  instructions?: string[];
  conventionRefs?: string[];
  components?: string[];
  owners?: string[];
  capabilities?: Capability[];
  examples?: TaskReference[];
  generators?: string[];
};
export type TaskKnowledge = {
  schemaVersion: 1;
  scopes: TaskScope[];
  alwaysInstructions?: string[];
  completion?: { tier: string } | { command: string[]; source: string };
  exceptions?: Array<{ ruleId: string; source: string }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim());
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function portableTaskPath(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !/[\\:\0#]/.test(value) &&
    !value.split("/").includes("..")
  );
}

function invalid(message: string): never {
  throw new Error(`taskKnowledge: ${message}`);
}

export function validateTaskKnowledge(value: unknown): asserts value is TaskKnowledge | undefined {
  if (value === undefined) return;
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !keys(value, ["schemaVersion", "scopes", "alwaysInstructions", "completion", "exceptions"]) ||
    !Array.isArray(value.scopes)
  )
    invalid("must declare schemaVersion 1 and a scopes array");
  if (
    value.alwaysInstructions !== undefined &&
    (!strings(value.alwaysInstructions) || !value.alwaysInstructions.every(portableTaskPath))
  )
    invalid("alwaysInstructions must contain repository paths");
  const ids = new Set<string>();
  for (const scope of value.scopes) {
    if (
      !record(scope) ||
      typeof scope.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(scope.id) ||
      ids.has(scope.id) ||
      !strings(scope.paths) ||
      !scope.paths.length ||
      !scope.paths.every(portableTaskPath) ||
      !keys(scope, [
        "id",
        "paths",
        "taskKinds",
        "instructions",
        "conventionRefs",
        "components",
        "owners",
        "capabilities",
        "examples",
        "generators",
      ])
    )
      invalid("each scope needs a unique stable id and portable path selectors");
    ids.add(scope.id);
    for (const field of [
      "taskKinds",
      "instructions",
      "conventionRefs",
      "components",
      "owners",
      "capabilities",
      "generators",
    ]) {
      if (scope[field] !== undefined && !strings(scope[field]))
        invalid(`${scope.id}.${field} must be a string array`);
    }
    if (strings(scope.instructions) && !scope.instructions.every(portableTaskPath))
      invalid(`${scope.id}.instructions must use repository paths`);
    if (
      strings(scope.capabilities) &&
      scope.capabilities.some((item) => !capabilities.some((capability) => capability === item))
    )
      invalid(`${scope.id} references an unsupported capability`);
    if (scope.examples !== undefined) {
      if (!Array.isArray(scope.examples)) invalid(`${scope.id}.examples must be an array`);
      for (const example of scope.examples) {
        if (
          !record(example) ||
          !keys(example, ["path", "entrypoint"]) ||
          typeof example.path !== "string" ||
          !portableTaskPath(example.path) ||
          (example.entrypoint !== undefined &&
            (typeof example.entrypoint !== "string" || !example.entrypoint.trim()))
        )
          invalid(`${scope.id} has an invalid example pointer`);
      }
    }
  }
  if (value.completion !== undefined) {
    const completion = value.completion;
    if (!record(completion)) invalid("completion must declare a tier or a command with its source");
    if ("tier" in completion) {
      if (
        !keys(completion, ["tier"]) ||
        typeof completion.tier !== "string" ||
        !completion.tier.trim()
      )
        invalid("completion tier must be nonempty and exclusive");
    } else if (
      !keys(completion, ["command", "source"]) ||
      !strings(completion.command) ||
      !completion.command.length ||
      completion.command.some((part) => part.includes("\0")) ||
      typeof completion.source !== "string" ||
      !portableTaskPath(completion.source)
    )
      invalid("completion command must be a nonempty argument array with a repository source");
  }
  if (value.exceptions !== undefined) {
    if (!Array.isArray(value.exceptions)) invalid("exceptions must be an array");
    for (const exception of value.exceptions) {
      if (
        !record(exception) ||
        !keys(exception, ["ruleId", "source"]) ||
        typeof exception.ruleId !== "string" ||
        !/^[A-Z][A-Z0-9-]*-\d+$/.test(exception.ruleId) ||
        typeof exception.source !== "string" ||
        !portableTaskPath(exception.source)
      )
        invalid("exceptions must reference a stable rule and repository source");
    }
  }
}
