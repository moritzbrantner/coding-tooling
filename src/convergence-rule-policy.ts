import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ToolingConfig } from "./model.ts";
import { readJson } from "./shared.ts";

export const convergenceRuleModes = ["disabled", "suggest", "apply"] as const;
export type ConvergenceRuleMode = (typeof convergenceRuleModes)[number];

export type ConvergenceRuleNamespace = "generator" | "scaffold" | "refactor" | "normalizer";

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
      return "refactor.typescript-barrel-export";
    default:
      return undefined;
  }
}

export function normalizerRuleId(tool: string): string {
  switch (tool) {
    case "oxfmt":
      return "normalizer.oxfmt";
    case "oxlint":
      return "normalizer.oxlint-safe-fix";
    case "cargo-fmt":
      return "normalizer.rustfmt";
    case "dotnet-format":
      return "normalizer.dotnet-format";
    default:
      return convergenceRuleId("normalizer", tool);
  }
}

export function validateConvergenceRuleConfig(
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

export function convergenceRuleMode(root: string, id: string): ConvergenceRuleMode {
  const config = readJson<ToolingConfig>(join(root, ".coding-tooling.json"));
  if (!config || config.schemaVersion !== 1) return "apply";
  validateConvergenceRuleConfig(config);
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
  const config: ToolingConfig | undefined = existsSync(path)
    ? readJson<ToolingConfig>(path)
    : { schemaVersion: 1 };
  if (!config || config.schemaVersion !== 1)
    throw new Error(".coding-tooling.json must use schemaVersion 1");
  validateConvergenceRuleConfig(config);

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
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    changed: previousMode !== mode || config.convergence?.rules?.[id] !== mode,
    previousMode,
    mode,
  };
}
