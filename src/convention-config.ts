import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Capability, Component } from "./model.ts";
import { readJson, walkFiles } from "./shared.ts";

type SupportedTool = "oxlint" | "oxfmt";

type InstalledConventionConfiguration = {
  module: string;
  rule: string;
  path: string;
  tool: SupportedTool;
  capability: Capability;
};

type PackageManifest = {
  scripts?: Record<string, string>;
};

type RepositoryToolConfig = {
  path?: string;
  value: Record<string, unknown>;
};

type ConventionFragment = {
  rule: string;
  path: string;
  value: Record<string, unknown>;
};

const configurationManifestPath = ".conventions/configurations.json";
const supportedToolConfigNames: Record<SupportedTool, string[]> = {
  oxlint: [".oxlintrc.json", ".oxlintrc.jsonc"],
  oxfmt: [".oxfmtrc.json", ".oxfmtrc.jsonc"],
};
const unsupportedToolConfigNames: Record<SupportedTool, string[]> = {
  oxlint: ["oxlint.config.ts", "oxlint.config.mts"],
  oxfmt: [
    "oxfmt.config.ts",
    "oxfmt.config.mts",
    "oxfmt.config.cts",
    "oxfmt.config.js",
    "oxfmt.config.mjs",
    "oxfmt.config.cjs",
  ],
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

function stripComments(source: string): string {
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
  return result;
}

function stripTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
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
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
      if (source[cursor] === "}" || source[cursor] === "]") continue;
    }
    result += char;
  }
  return result;
}

function parseJsonc(source: string, label: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripComments(source))) as unknown;
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
    const realInstallRoot = realpathSync(installRoot);
    const realAsset = realpathSync(absolute);
    if (!withinRoot(realInstallRoot, realAsset)) {
      throw new Error(`Convention configuration asset escapes the managed snapshot: ${path}`);
    }
    return { module, rule, path, tool, capability } as InstalledConventionConfiguration;
  });
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]),
      )
    );
  }
  return false;
}

function severity(value: unknown): number | undefined {
  if (value === 0 || value === "off") return 0;
  if (value === 1 || value === "warn" || value === "warning") return 1;
  if (value === 2 || value === "error") return 2;
  return undefined;
}

function ruleSetting(value: unknown): { severity: number; options: unknown[] } | undefined {
  if (Array.isArray(value) && value.length > 0) {
    const rank = severity(value[0]);
    return rank === undefined ? undefined : { severity: rank, options: value.slice(1) };
  }
  const rank = severity(value);
  return rank === undefined ? undefined : { severity: rank, options: [] };
}

function mergeRuleSetting(base: unknown, requirement: unknown, path: string): unknown | undefined {
  if (!path.startsWith("rules.")) return undefined;
  const baseSetting = ruleSetting(base);
  const requiredSetting = ruleSetting(requirement);
  if (!baseSetting || !requiredSetting) return undefined;
  if (
    baseSetting.severity > 0 &&
    requiredSetting.severity > 0 &&
    !equal(baseSetting.options, requiredSetting.options)
  ) {
    throw new Error(`convention-config-conflict at ${path}`);
  }
  return structuredClone(baseSetting.severity >= requiredSetting.severity ? base : requirement);
}

function mergeRequirement(base: unknown, requirement: unknown, path: string): unknown {
  if (base === undefined) return structuredClone(requirement);
  const ruleValue = mergeRuleSetting(base, requirement, path);
  if (ruleValue !== undefined) return ruleValue;
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
  for (const fragment of [...fragments].sort((left, right) => left.rule.localeCompare(right.rule))) {
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

function allToolConfigNames(tool: SupportedTool): string[] {
  return [...supportedToolConfigNames[tool], ...unsupportedToolConfigNames[tool]];
}

function findRepositoryConfigPath(root: string, component: Component, tool: SupportedTool): string | undefined {
  let current = resolve(componentDirectory(root, component));
  const boundary = resolve(root);
  while (true) {
    const supported = supportedToolConfigNames[tool]
      .map((name) => join(current, name))
      .filter(existsSync);
    const unsupported = unsupportedToolConfigNames[tool]
      .map((name) => join(current, name))
      .filter(existsSync);
    if (unsupported.length > 0) {
      throw new Error(
        `${tool} convention composition currently requires JSON/JSONC config; unsupported config: ${unsupported[0]}`,
      );
    }
    if (supported.length > 1) {
      throw new Error(`Multiple ${tool} configuration files are present in ${current}`);
    }
    if (supported.length === 1) return supported[0];
    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current || !withinRoot(boundary, parent)) return undefined;
    current = parent;
  }
}

function assertNoNestedConfigs(
  root: string,
  component: Component,
  tool: SupportedTool,
  selectedPath?: string,
): void {
  const directory = resolve(componentDirectory(root, component));
  const selected = selectedPath ? resolve(selectedPath) : undefined;
  const names = new Set(allToolConfigNames(tool));
  const nested = walkFiles(directory, 10)
    .filter((path) => names.has(basename(path)))
    .map((path) => resolve(path))
    .filter((path) => path !== selected);
  if (nested.length > 0) {
    throw new Error(
      `${tool} convention composition does not yet support nested config trees; found ${nested[0]}`,
    );
  }
}

function repositoryToolConfig(
  root: string,
  component: Component,
  tool: SupportedTool,
): RepositoryToolConfig {
  const path = findRepositoryConfigPath(root, component, tool);
  assertNoNestedConfigs(root, component, tool, path);
  if (!path) return { value: {} };
  const parsed = parseJsonc(readFileSync(path, "utf8"), path);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return { path, value: parsed };
}

function fragment(root: string, config: InstalledConventionConfiguration): ConventionFragment {
  const path = resolve(root, ".conventions", config.path);
  const parsed = parseJsonc(readFileSync(path, "utf8"), path);
  if (!isRecord(parsed)) throw new Error(`Convention configuration ${config.rule} must contain a JSON object`);
  return { rule: config.rule, path, value: parsed };
}

function assertPortableFragment(tool: SupportedTool, item: ConventionFragment): void {
  const forbidden =
    tool === "oxlint"
      ? ["extends", "ignorePatterns", "overrides", "jsPlugins"]
      : ["ignorePatterns", "overrides", "sortTailwindcss"];
  const key = forbidden.find((candidate) => Object.prototype.hasOwnProperty.call(item.value, candidate));
  if (key) {
    throw new Error(
      `Convention configuration ${item.rule} uses path-sensitive ${tool} field ${key}, which is not supported by the current composition adapter`,
    );
  }
}

function assertPortableOxfmtRepositoryConfig(config: RepositoryToolConfig): void {
  if (!config.path) return;
  const forbidden = ["ignorePatterns", "overrides", "sortTailwindcss"];
  const key = forbidden.find((candidate) => Object.prototype.hasOwnProperty.call(config.value, candidate));
  if (key) {
    throw new Error(
      `Oxfmt repository config ${config.path} uses path-sensitive field ${key}; convention composition refuses to change its path semantics`,
    );
  }
}

function packageScriptName(command: string[]): string | undefined {
  const manager = basename(command[0] ?? "");
  if (manager !== "bun" && manager !== "npm" && manager !== "pnpm" && manager !== "yarn") {
    return undefined;
  }
  const runIndex = command.indexOf("run");
  if (runIndex < 0) return undefined;
  const name = command[runIndex + 1];
  return name && !name.startsWith("-") ? name : undefined;
}

function packageScriptForCommand(
  root: string,
  component: Component,
  command: string[],
): string | undefined {
  if (component.kind !== "package") return undefined;
  const name = packageScriptName(command);
  if (!name) return undefined;
  const manifest = readJson<PackageManifest>(join(componentDirectory(root, component), "package.json"));
  return manifest?.scripts?.[name];
}

function tokenIsTool(token: string, tool: SupportedTool): boolean {
  return basename(token) === tool || token === tool;
}

function tokenSelectsConfig(token: string): boolean {
  return (
    token === "--config" ||
    token.startsWith("--config=") ||
    token === "-c" ||
    (token.startsWith("-c") && token.length > 2)
  );
}

function safePackageScriptUsesTool(script: string, tool: SupportedTool): boolean {
  const mentionsTool = new RegExp(`(^|[^a-zA-Z0-9_-])${tool}([^a-zA-Z0-9_-]|$)`).test(script);
  if (!mentionsTool) return false;
  if (/&&|\|\||[;|<>\n\r]/.test(script)) {
    throw new Error(`Cannot safely inject convention config into compound package script: ${script}`);
  }
  const tokens = script.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  if (!tokenIsTool(first, tool)) {
    throw new Error(`Cannot safely identify ${tool} as the package-script entrypoint: ${script}`);
  }
  if (tokens.slice(1).some(tokenSelectsConfig)) {
    throw new Error(`Cannot compose convention config with a package script that already selects a config: ${script}`);
  }
  return true;
}

function commandUsesTool(
  root: string,
  component: Component,
  command: string[],
  tool: SupportedTool,
): boolean {
  if (command.some((token) => tokenIsTool(token, tool))) return true;
  const script = packageScriptForCommand(root, component, command);
  return Boolean(script && safePackageScriptUsesTool(script, tool));
}

function invocationConfig(
  tool: SupportedTool,
  repositoryConfig: RepositoryToolConfig,
  fragments: ConventionFragment[],
): Record<string, unknown> {
  for (const item of fragments) assertPortableFragment(tool, item);
  const conventionOnly = composeToolConfiguration(
    {},
    fragments.map((item) => ({ rule: item.rule, value: item.value })),
  );
  composeToolConfiguration(
    repositoryConfig.value,
    fragments.map((item) => ({ rule: item.rule, value: item.value })),
  );

  if (tool === "oxlint") {
    return {
      ...(repositoryConfig.path ? { extends: [resolve(repositoryConfig.path)], plugins: [] } : {}),
      ...conventionOnly,
    };
  }

  assertPortableOxfmtRepositoryConfig(repositoryConfig);
  return composeToolConfiguration(
    repositoryConfig.value,
    fragments.map((item) => ({ rule: item.rule, value: item.value })),
  );
}

function effectiveConfigPath(tool: SupportedTool, config: Record<string, unknown>): string {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const directory = join(tmpdir(), "coding-tooling-convention-config", digest);
  mkdirSync(directory, { recursive: true });
  const filename = tool === "oxlint" ? ".oxlintrc.json" : ".oxfmtrc.json";
  const path = join(directory, filename);
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
  return path;
}

function commandWithConfig(command: string[], tool: SupportedTool, configPath: string): string[] {
  const flags = ["--config", configPath, "--disable-nested-config"];
  const toolIndex = command.findIndex((token) => tokenIsTool(token, tool));
  if (toolIndex >= 0) {
    if (command.slice(toolIndex + 1).some(tokenSelectsConfig)) {
      throw new Error(`Cannot compose convention config with a command that already selects a config`);
    }
    return [...command.slice(0, toolIndex + 1), ...flags, ...command.slice(toolIndex + 1)];
  }
  if (command[0] === "bun" && command.includes("run")) return [...command, ...flags];
  if (command[0] === "npm" && command.includes("run")) return [...command, "--", ...flags];
  if ((command[0] === "pnpm" || command[0] === "yarn") && command.includes("run")) {
    return [...command, ...flags];
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
      const matchingTools = tools.filter((tool) => commandUsesTool(root, component, original, tool));
      if (matchingTools.length !== 1) {
        throw new Error(
          `No unique convention configuration adapter matches ${component.name} ${capability}; configured tools: ${tools.join(", ")}`,
        );
      }
      const tool = matchingTools[0]!;
      const fragments = applicable
        .filter((configuration) => configuration.tool === tool)
        .map((configuration) => fragment(root, configuration));
      const repositoryConfig = repositoryToolConfig(root, component, tool);
      const effective = invocationConfig(tool, repositoryConfig, fragments);
      capabilities[capability] = commandWithConfig(
        original,
        tool,
        effectiveConfigPath(tool, effective),
      );
    }
    return { ...component, capabilities };
  });
}
