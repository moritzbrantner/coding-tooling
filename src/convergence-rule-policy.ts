import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ToolingConfig } from "./model.ts";
import { readJson } from "./shared.ts";

export const convergenceRuleModes = ["disabled", "suggest", "apply"] as const;
export type ConvergenceRuleMode = (typeof convergenceRuleModes)[number];

export type ConvergenceRuleNamespace = "generator" | "scaffold" | "refactor" | "normalizer";

export const builtInScaffoldRuleIds = ["scaffold.typescript-source-test"] as const;
export const builtInRefactorRuleIds = ["refactor.typescript-barrel-export"] as const;
export const builtInNormalizerRuleIds = [
  "normalizer.oxfmt",
  "normalizer.oxlint-safe-fix",
  "normalizer.rustfmt",
  "normalizer.dotnet-format",
] as const;

const convergenceRuleIdPattern = /^(generator|scaffold|refactor|normalizer)\.[a-z0-9][a-z0-9._-]*$/;

export function convergenceRuleId(kind: ConvergenceRuleNamespace, id: string): string {
  return `${kind}.${id}`;
}

export function scaffoldRuleId(expectationId: string): string {
  return convergenceRuleId("scaffold", expectationId);
}

export function refactorRuleId(operation: string): string | undefined {
  switch (operation) {
    case "typescript-barrel-export":
      return builtInRefactorRuleIds[0];
    default:
      return undefined;
  }
}

export function normalizerRuleId(tool: string): string {
  switch (tool) {
    case "oxfmt":
      return builtInNormalizerRuleIds[0];
    case "oxlint":
      return builtInNormalizerRuleIds[1];
    case "cargo-fmt":
      return builtInNormalizerRuleIds[2];
    case "dotnet-format":
      return builtInNormalizerRuleIds[3];
    default:
      return convergenceRuleId("normalizer", tool);
  }
}

function validateConvergenceRuleConfigShape(
  config: ToolingConfig,
  configuredPath = ".coding-tooling.json",
): void {
  const rules = config.convergence?.rules;
  if (rules === undefined) return;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error(`${configuredPath}.convergence.rules must be an object`);
  }
  for (const [id, mode] of Object.entries(rules)) {
    if (!convergenceRuleIdPattern.test(id)) {
      throw new Error(`Invalid convergence rule id: ${id}`);
    }
    if (!convergenceRuleModes.includes(mode as ConvergenceRuleMode)) {
      throw new Error(`Invalid convergence rule mode for ${id}: ${String(mode)}`);
    }
  }
}

function assertKnownStaticConvergenceRuleIds(config: ToolingConfig): void {
  const known = new Set<string>([
    ...builtInScaffoldRuleIds,
    ...builtInRefactorRuleIds,
    ...builtInNormalizerRuleIds,
  ]);
  const unknown = Object.keys(config.convergence?.rules ?? {})
    .filter(
      (id) =>
        (id.startsWith("scaffold.") ||
          id.startsWith("refactor.") ||
          id.startsWith("normalizer.")) &&
        !known.has(id),
    )
    .sort();
  if (unknown.length === 0) return;
  throw new Error(
    `Unknown configured convergence rule ${unknown.length === 1 ? "id" : "ids"}: ${unknown.join(", ")}`,
  );
}

export function validateConvergenceRuleConfig(
  config: ToolingConfig,
  configuredPath = ".coding-tooling.json",
): void {
  validateConvergenceRuleConfigShape(config, configuredPath);
  assertKnownStaticConvergenceRuleIds(config);
}

function readConvergenceRuleConfig(root: string, validateKnownRules = true): ToolingConfig {
  const path = join(root, ".coding-tooling.json");
  if (!existsSync(path)) return { schemaVersion: 1 };
  const config = readJson<ToolingConfig>(path);
  if (!config || config.schemaVersion !== 1) {
    throw new Error(".coding-tooling.json must use schemaVersion 1");
  }
  if (validateKnownRules) validateConvergenceRuleConfig(config);
  else validateConvergenceRuleConfigShape(config);
  return config;
}

export function validateConvergenceRulePolicy(root: string): void {
  readConvergenceRuleConfig(root);
}

export function configuredConvergenceRuleIds(
  root: string,
  namespace?: ConvergenceRuleNamespace,
): string[] {
  const ids = Object.keys(readConvergenceRuleConfig(root).convergence?.rules ?? {});
  return ids.filter((id) => namespace === undefined || id.startsWith(`${namespace}.`)).sort();
}

export function assertKnownConvergenceRuleIds(
  root: string,
  namespace: ConvergenceRuleNamespace,
  knownRuleIds: Iterable<string>,
): void {
  const known = new Set(knownRuleIds);
  const unknown = configuredConvergenceRuleIds(root, namespace).filter((id) => !known.has(id));
  if (unknown.length === 0) return;
  throw new Error(
    `Unknown configured convergence ${namespace} rule ${unknown.length === 1 ? "id" : "ids"}: ${unknown.join(", ")}`,
  );
}

export function convergenceRuleMode(root: string, id: string): ConvergenceRuleMode {
  const config = readConvergenceRuleConfig(root);
  return config.convergence?.rules?.[id] ?? "apply";
}

export function convergenceRuleModeForPlanning(root: string, id: string): ConvergenceRuleMode {
  const config = readConvergenceRuleConfig(root, false);
  return config.convergence?.rules?.[id] ?? "apply";
}

export function setConvergenceRuleMode(
  root: string,
  id: string,
  mode: ConvergenceRuleMode,
): { changed: boolean; previousMode: ConvergenceRuleMode; mode: ConvergenceRuleMode } {
  if (!convergenceRuleIdPattern.test(id)) throw new Error(`Invalid convergence rule id: ${id}`);
  if (!convergenceRuleModes.includes(mode))
    throw new Error(`Invalid convergence rule mode: ${mode}`);

  const path = join(root, ".coding-tooling.json");
  const config = readConvergenceRuleConfig(root);

  const previousMode = config.convergence?.rules?.[id] ?? "apply";
  if (previousMode === mode && config.convergence?.rules?.[id] === mode) {
    return { changed: false, previousMode, mode };
  }

  const next: ToolingConfig = {
    ...config,
    convergence: {
      ...config.convergence,
      rules: {
        ...config.convergence?.rules,
        [id]: mode,
      },
    },
  };
  validateConvergenceRuleConfig(next);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    changed: previousMode !== mode || config.convergence?.rules?.[id] !== mode,
    previousMode,
    mode,
  };
}
