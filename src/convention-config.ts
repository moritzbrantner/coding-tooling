import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type { Capability, Component } from "./model.ts";
import { findNearestFile, readJson } from "./shared.ts";

type SupportedTool = "oxlint" | "oxfmt";

type InstalledConventionConfiguration = {
  module: string;
  rule: string;
  path: string;
  tool: SupportedTool;
  capability: Capability;
};

type InstalledConfigurationManifest = {
  schemaVersion: 1;
  configurations: InstalledConventionConfiguration[];
};

type PackageManifest = {
  scripts?: Record<string, string>;
};

const configurationManifestPath = ".conventions/configurations.json";
const toolConfigNames: Record<SupportedTool, string[]> = {
  oxlint: [".oxlintrc.json", ".oxlintrc.jsonc"],
  oxfmt: [".oxfmtrc.json", ".oxfmtrc.jsonc"],
};
const capabilityScripts: Partial<Record<Capability, string[]>> = {
  lint: ["lint"],
  "format:check": ["format:check", "check:format"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function withinRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function parseJsonc(source: string, label: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n") result += "\n";
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }
  try {
    return JSON.parse(result) as unknown;
  } catch {
    throw new Error(`Convention config is not valid JSON/JSONC: ${label}`);
  }
}

export function loadInstalledConventionConfigurations(root: string): InstalledConventionConfiguration[] {
  const installRoot = resolve(root, ".conventions");
  const manifestPath = resolve(root, configurationManifestPath);
  if (!existsSync(manifestPath)) return [];
  const value = readJson<unknown>(manifestPath);
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.configurations)) {
    throw new Error(`${configurationManifestPath} is invalid`);
  }
  return value.configurations.map((item) => {
    if (!isRecord(item)) throw new Error(`${configurationManifestPath} contains invalid metadata`);
    const module = item.module;
    const rule = item.rule;
    const path = item.path;
    const tool = item.tool;
    const capability = item.capability;
    if (
      typeof module !== "string" ||
      typeof rule !== "string" ||
      typeof path !== "string" ||
      !isManagedPath(path) ||
      (tool !== "oxlint" && tool !== "oxfmt") ||
      (capability !== "lint" && capability !== "format:check") ||
      (tool === "oxlint" && capability !== "lint") ||
      (tool === "oxfmt" && capability !== "format:check")
    ) {
      throw new Error(`${configurationManifestPath} contains invalid configuration metadata`);
    }
    const absolute = resolve(installRoot, path);
    if (!withinRoot(installRoot, absolute) || !existsSync(absolute)) {
      throw new Error(`Convention configuration asset is missing or escapes the managed snapshot: ${path}`);
    }
    return { module, rule, path, tool, capability } as InstalledConventionConfiguration;
  });
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeRequirement(base: unknown, requirement: unknown, path: string): unknown {
  if (base === undefined) return structuredClone(requirement);
  if (isRecord(base) && isRecord(requirement)) {
    const result: Record<string, unknown> = structuredClone(base);
    for (const [key, value] of Object.entries(requirement)) {
      result[key] = mergeRequirement(result[key], value, path ? `${path}.${key}` : key);
    }
    return result;
  }
  if (Array.isArray(base) && Array.isArray(requirement)) {
    if (
      path === "plugins" &&
      base.every((item) => typeof item === "string") &&
      requirement.every((item) => typeof item === "string")
    ) {
      return [...new Set([...base, ...requirement])].sort();
    }
    if (equal(base, requirement)) return structuredClone(base);
    throw new Error(`convention-config-conflict at ${path}`);
  }
  if (equal(base, requirement)) return structuredClone(base);
  throw new Error(`convention-config-conflict at ${path}`);
}

export function composeToolConfiguration(
  repositoryConfig: Record<string, unknown>,
  fragments: Array<{ rule: string; value: Record<string, unknown> }>,
): Record<string, unknown> {
  let result: Record<string, unknown> = structuredClone(repositoryConfig);
  for (const fragment of fragments.toSorted((left, right) => left.rule.localeCompare(right.rule))) {
    try {
      result = mergeRequirement(result, fragment.value, "") as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} while applying ${fragment.rule}`);
    }
  }
  return result;
}

function componentDirectory(root: string, component: Component): string {
  return component.path === "." ? root : join(root, component.path);
}

function repositoryToolConfig(root: string, component: Component, tool: SupportedTool): Record<string, unknown> {
  const path = findNearestFile(componentDirectory(root, component), root, toolConfigNames[tool]);
  if (!path) return {};
  const parsed = parseJsonc(readFileSync(path, "utf8"), path);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function fragmentValue(root: string, config: InstalledConventionConfiguration): Record<string, unknown> {
  const path = join(root, ".conventions", config.path);
  const parsed = parseJsonc(readFileSync(path, "utf8"), path);
  if (!isRecord(parsed)) throw new Error(`Convention configuration ${config.rule} must contain a JSON object`);
  return parsed;
}

function packageScript(root: string, component: Component, capability: Capability): string | undefined {
  if (component.kind !== "package") return undefined;
  const manifest = readJson<PackageManifest>(join(componentDirectory(root, component), "package.json"));
  const names = capabilityScripts[capability] ?? [];
  const name = names.find((candidate) => candidate in (manifest?.scripts ?? {}));
  return name ? manifest?.scripts?.[name] : undefined;
}

function tokenIsTool(token: string, tool: SupportedTool): boolean {
  return basename(token) === tool || token === tool;
}

function commandUsesTool(
  root: string,
  component: Component,
  capability: Capability,
  command: string[],
  tool: SupportedTool,
): boolean {
  if (command.some((token) => tokenIsTool(token, tool))) return true;
  const script = packageScript(root, component, capability);
  return Boolean(script && new RegExp(`(^|[^a-zA-Z0-9_-])${tool}([^a-zA-Z0-9_-]|$)`).test(script));
}

function effectiveConfigPath(tool: SupportedTool, config: Record<string, unknown>): string {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const directory = join(tmpdir(), "coding-tooling-convention-config", digest);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${tool}.json`);
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
  return path;
}

function commandWithConfig(command: string[], tool: SupportedTool, configPath: string): string[] {
  const toolIndex = command.findIndex((token) => tokenIsTool(token, tool));
  if (toolIndex >= 0) {
    return [
      ...command.slice(0, toolIndex + 1),
      "--config",
      configPath,
      "--disable-nested-config",
      ...command.slice(toolIndex + 1),
    ];
  }
  if (
    (command[0] === "bun" || command[0] === "npm" || command[0] === "pnpm" || command[0] === "yarn") &&
    command.includes("run")
  ) {
    return [...command, "--", "--config", configPath, "--disable-nested-config"];
  }
  throw new Error(`Cannot inject convention config into command: ${command.join(" ")}`);
}

function configurationApplies(
  component: Component,
  configuration: InstalledConventionConfiguration,
): boolean {
  return (
    component.kind === "package" &&
    (component.technologies.includes(configuration.module) || configuration.module === "tooling")
  );
}

export function applyConventionConfigurations(root: string, components: Component[]): Component[] {
  const configurations = loadInstalledConventionConfigurations(root);
  if (!configurations.length) return components;

  return components.map((component) => {
    const capabilities = { ...component.capabilities };
    for (const capability of ["lint", "format:check"] as const) {
      const original = capabilities[capability];
      if (!original) continue;
      const applicable = configurations.filter(
        (configuration) =>
          configuration.capability === capability && configurationApplies(component, configuration),
      );
      if (!applicable.length) continue;

      const tools = [...new Set(applicable.map((configuration) => configuration.tool))];
      const matchingTools = tools.filter((tool) =>
        commandUsesTool(root, component, capability, original, tool),
      );
      if (matchingTools.length !== 1) {
        throw new Error(
          `No unique convention configuration adapter matches ${component.name} ${capability}; configured tools: ${tools.join(", ")}`,
        );
      }
      const tool = matchingTools[0]!;
      const fragments = applicable
        .filter((configuration) => configuration.tool === tool)
        .map((configuration) => ({
          rule: configuration.rule,
          value: fragmentValue(root, configuration),
        }));
      const effective = composeToolConfiguration(repositoryToolConfig(root, component, tool), fragments);
      capabilities[capability] = commandWithConfig(original, tool, effectiveConfigPath(tool, effective));
    }
    return { ...component, capabilities };
  });
}
