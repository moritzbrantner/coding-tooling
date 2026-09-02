import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readJson, repositoryRoot } from "./shared.ts";

export const RENOVATE_PRESET = "github>moritzbrantner/coding-agent-conventions";

export const RENOVATE_CONSUMER_CONFIG = {
  $schema: "https://docs.renovatebot.com/renovate-schema.json",
  extends: [RENOVATE_PRESET],
};

const renovateConfigPaths = [
  "renovate.json",
  "renovate.jsonc",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.jsonc",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.jsonc",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.jsonc",
  ".renovaterc.json5",
] as const;

const dependabotConfigPaths = [
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
] as const;

type PackageManifest = {
  renovate?: unknown;
};

export type RenovateFoundationRecommendation = {
  preset: string;
  configPath: string;
  existingConfigPath: string | null;
  dependabotConfigPath: string | null;
  config: typeof RENOVATE_CONSUMER_CONFIG;
};

export type RenovateFoundationInstall = RenovateFoundationRecommendation & {
  changed: boolean;
  blockedByDependabot: boolean;
};

function firstExisting(root: string, candidates: readonly string[]): string | null {
  return candidates.find((candidate) => existsSync(join(root, candidate))) ?? null;
}

function packageJsonHasRenovate(root: string): boolean {
  const manifest = readJson<PackageManifest>(join(root, "package.json"));
  return manifest?.renovate !== undefined;
}

export function renovateFoundationRecommendation(
  root = repositoryRoot(),
): RenovateFoundationRecommendation {
  const resolvedRoot = resolve(root);
  const fileConfigPath = firstExisting(resolvedRoot, renovateConfigPaths);
  const existingConfigPath =
    fileConfigPath ?? (packageJsonHasRenovate(resolvedRoot) ? "package.json" : null);
  return {
    preset: RENOVATE_PRESET,
    configPath: existingConfigPath ?? "renovate.json",
    existingConfigPath,
    dependabotConfigPath: firstExisting(resolvedRoot, dependabotConfigPaths),
    config: RENOVATE_CONSUMER_CONFIG,
  };
}

export function installRenovateFoundation(
  root = repositoryRoot(),
): RenovateFoundationInstall {
  const resolvedRoot = resolve(root);
  const recommendation = renovateFoundationRecommendation(resolvedRoot);
  const blockedByDependabot =
    recommendation.existingConfigPath === null && recommendation.dependabotConfigPath !== null;

  if (recommendation.existingConfigPath === null && !blockedByDependabot) {
    writeFileSync(
      join(resolvedRoot, recommendation.configPath),
      `${JSON.stringify(recommendation.config, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    ...recommendation,
    changed: recommendation.existingConfigPath === null && !blockedByDependabot,
    blockedByDependabot,
  };
}
