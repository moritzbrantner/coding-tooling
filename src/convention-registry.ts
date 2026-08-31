import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { resolveConventionSource } from "./conventions.ts";
import type {
  Capability,
  Diagnostic,
  ResultEnvelope,
  ResultOperation,
  ResultStatus,
} from "./model.ts";
import { readJson, runCommand, walkFiles } from "./shared.ts";

type RegistryConfiguration = {
  rule: string;
  path: string;
  tool: "oxlint" | "oxfmt";
  capability: Capability;
};

type RegistryModule = {
  description?: string;
  sources: string[];
  assets?: string[];
  configurations?: RegistryConfiguration[];
  dependencies?: string[];
};

type RegistryManifest = {
  schemaVersion: 1;
  modules: Record<string, RegistryModule>;
  profiles?: Record<string, string[]>;
};

type ConsumerManifest = {
  schemaVersion: 1;
  registry: "coding-agent-conventions";
  modules: string[];
};

type ConventionLock = {
  schemaVersion: 1;
  sourceRevision: string;
  requestedModules: string[];
  resolvedModules: string[];
  files: Record<string, string>;
};

type RegistryOptions = {
  root: string;
  conventionsRoot?: string;
  registryPath?: string;
  profile?: string;
};

type InstalledConfiguration = RegistryConfiguration & { module: string; path: string };

type Snapshot = {
  sourceRevision: string;
  requestedModules: string[];
  resolvedModules: string[];
  files: Map<string, string>;
};

type RuleBriefing = {
  id: string;
  title: string;
  directive?: string;
  path: string;
};

const manifestName = "conventions.json";
const lockName = "conventions.lock.json";
const installDirectory = ".conventions";
const configurationManifestName = "configurations.json";
const moduleNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const ruleIdPattern = /^[A-Z][A-Z0-9-]*-\d+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const ruleHeadingPattern = /^##\s+([A-Z][A-Z0-9-]*-\d+)\s+—\s+(.+?)\s*$/;
const bulletPattern = /^\s*[-*]\s+(.+?)\s*$/;
const supportedConfigurationCapabilities = new Set<Capability>(["lint", "format:check"]);

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function revision(root: string): string {
  const head = runCommand("git", ["rev-parse", "HEAD"], root);
  if (head.status !== 0 || !head.stdout.trim()) return "unversioned";
  const status = runCommand("git", ["status", "--porcelain"], root);
  const suffix = status.status === 0 && status.stdout.trim() ? "-dirty" : "";
  return `${head.stdout.trim()}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModuleName(value: unknown): value is string {
  return typeof value === "string" && moduleNamePattern.test(value);
}

function isModuleList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isModuleName) && new Set(value).size === value.length;
}

function isManagedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && isManagedPath(item)) &&
    new Set(value).size === value.length
  );
}

function isFileHashRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([path, digest]) =>
        isManagedPath(path) && typeof digest === "string" && sha256Pattern.test(digest),
    )
  );
}

function assertModuleName(name: string): void {
  if (!isModuleName(name)) throw new Error(`Invalid convention module name: ${name}`);
}

function parseConfiguration(
  value: unknown,
  moduleName: string,
  assets: string[],
): RegistryConfiguration {
  if (!isRecord(value))
    throw new Error(`Convention module ${moduleName} has invalid configuration metadata`);
  const rule = value.rule;
  const path = value.path;
  const tool = value.tool;
  const capability = value.capability;
  if (typeof rule !== "string" || !ruleIdPattern.test(rule)) {
    throw new Error(`Convention module ${moduleName} has invalid configuration rule`);
  }
  if (typeof path !== "string" || !isManagedPath(path) || !assets.includes(path)) {
    throw new Error(
      `Convention module ${moduleName} configuration ${rule} must reference a declared asset`,
    );
  }
  if (tool !== "oxlint" && tool !== "oxfmt") {
    throw new Error(
      `Convention module ${moduleName} configuration ${rule} uses unsupported tool: ${String(tool)}`,
    );
  }
  if (
    typeof capability !== "string" ||
    !supportedConfigurationCapabilities.has(capability as Capability) ||
    (tool === "oxlint" && capability !== "lint") ||
    (tool === "oxfmt" && capability !== "format:check")
  ) {
    throw new Error(`Convention module ${moduleName} configuration ${rule} has invalid capability`);
  }
  return { rule, path, tool, capability: capability as Capability };
}

function loadRegistry(sourceRoot: string): RegistryManifest {
  const path = join(sourceRoot, "registry", "registry.json");
  const value = readJson<unknown>(path);
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.modules)) {
    throw new Error(`Invalid convention registry manifest: ${path}`);
  }

  const modules: Record<string, RegistryModule> = {};
  for (const [name, rawModule] of Object.entries(value.modules)) {
    assertModuleName(name);
    if (!isRecord(rawModule) || !Array.isArray(rawModule.sources)) {
      throw new Error(`Invalid convention registry module: ${name}`);
    }
    const sources = rawModule.sources;
    if (
      !sources.length ||
      !sources.every((source) => typeof source === "string" && source.length > 0)
    ) {
      throw new Error(`Convention module ${name} has invalid sources`);
    }
    const assets = rawModule.assets ?? [];
    if (!isPathList(assets)) throw new Error(`Convention module ${name} has invalid assets`);
    const rawConfigurations = rawModule.configurations ?? [];
    if (!Array.isArray(rawConfigurations)) {
      throw new Error(`Convention module ${name} has invalid configurations`);
    }
    const configurations = rawConfigurations.map((item) => parseConfiguration(item, name, assets));
    const dependencies = rawModule.dependencies ?? [];
    if (!isModuleList(dependencies))
      throw new Error(`Convention module ${name} has invalid dependencies`);
    modules[name] = {
      description: typeof rawModule.description === "string" ? rawModule.description : undefined,
      sources: sources as string[],
      assets,
      configurations,
      dependencies,
    };
  }

  let profiles: Record<string, string[]> | undefined;
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) throw new Error(`Invalid convention registry profiles: ${path}`);
    profiles = {};
    for (const [name, modulesForProfile] of Object.entries(value.profiles)) {
      if (!name || !isModuleList(modulesForProfile))
        throw new Error(`Invalid convention registry profile: ${name}`);
      profiles[name] = modulesForProfile;
    }
  }

  return { schemaVersion: 1, modules, profiles };
}

function loadConsumer(root: string): ConsumerManifest | undefined {
  const value = readJson<unknown>(join(root, manifestName));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.registry !== "coding-agent-conventions" ||
    !isModuleList(value.modules)
  )
    return undefined;
  return { schemaVersion: 1, registry: "coding-agent-conventions", modules: value.modules };
}

function loadLock(root: string): ConventionLock | undefined {
  const value = readJson<unknown>(join(root, lockName));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceRevision !== "string" ||
    !value.sourceRevision ||
    !isModuleList(value.requestedModules) ||
    !isModuleList(value.resolvedModules) ||
    !isFileHashRecord(value.files) ||
    !Object.prototype.hasOwnProperty.call(value.files, "index.md")
  )
    return undefined;
  return {
    schemaVersion: 1,
    sourceRevision: value.sourceRevision,
    requestedModules: value.requestedModules,
    resolvedModules: value.resolvedModules,
    files: value.files,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveRequestedModules(
  registry: RegistryManifest,
  modules: string[],
  profile?: string,
): string[] {
  const profileModules = profile ? registry.profiles?.[profile] : undefined;
  if (profile && !profileModules) throw new Error(`Unknown convention profile: ${profile}`);
  const requested = unique([...(profileModules ?? []), ...modules]);
  for (const module of requested) {
    assertModuleName(module);
    if (!registry.modules[module]) throw new Error(`Unknown convention module: ${module}`);
  }
  return requested;
}

function resolveDependencies(registry: RegistryManifest, requested: string[]): string[] {
  const resolved: string[] = [];
  const active = new Set<string>();
  const done = new Set<string>();
  function visit(name: string): void {
    assertModuleName(name);
    if (done.has(name)) return;
    if (active.has(name)) throw new Error(`Convention module dependency cycle at ${name}`);
    const module = registry.modules[name];
    if (!module) throw new Error(`Unknown convention module dependency: ${name}`);
    active.add(name);
    for (const dependency of module.dependencies ?? []) visit(dependency);
    active.delete(name);
    done.add(name);
    resolved.push(name);
  }
  for (const name of requested) visit(name);
  return resolved;
}

function withinRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function safeRealPath(sourceRoot: string, candidate: string, label: string): string {
  const realRoot = realpathSync(sourceRoot);
  const realCandidate = realpathSync(candidate);
  if (!withinRoot(realRoot, realCandidate))
    throw new Error(`Convention source escapes registry root: ${label}`);
  return realCandidate;
}

function sourceFiles(sourceRoot: string, source: string): string[] {
  const root = resolve(sourceRoot);
  const absolute = resolve(root, source);
  if (!withinRoot(root, absolute))
    throw new Error(`Convention source escapes registry root: ${source}`);
  if (!existsSync(absolute)) throw new Error(`Convention source does not exist: ${source}`);
  const realSource = safeRealPath(root, absolute, source);
  if (statSync(realSource).isFile()) return [realSource];
  return walkFiles(realSource, 12)
    .filter((file) => file.endsWith(".md"))
    .map((file) => safeRealPath(root, file, source))
    .sort();
}

function assetFile(sourceRoot: string, asset: string): string {
  const root = resolve(sourceRoot);
  const absolute = resolve(root, asset);
  if (!withinRoot(root, absolute))
    throw new Error(`Convention asset escapes registry root: ${asset}`);
  if (!existsSync(absolute)) throw new Error(`Convention asset does not exist: ${asset}`);
  const realAsset = safeRealPath(root, absolute, asset);
  if (!statSync(realAsset).isFile()) throw new Error(`Convention asset must be a file: ${asset}`);
  return realAsset;
}

function extractRuleBriefings(content: string, path: string): RuleBriefing[] {
  const lines = content.split(/\r?\n/);
  const briefings: RuleBriefing[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = ruleHeadingPattern.exec(lines[index] ?? "");
    if (!heading) continue;
    let directive: string | undefined;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (/^#{1,6}\s+/.test(line)) break;
      const bullet = bulletPattern.exec(line);
      if (bullet) {
        directive = bullet[1];
        break;
      }
    }
    briefings.push({ id: heading[1], title: heading[2], directive, path });
  }
  return briefings;
}

function indexContent(
  resolvedModules: string[],
  moduleSources: Map<string, string[]>,
  moduleAssets: Map<string, string[]>,
  briefings: RuleBriefing[],
): string {
  const lines = [
    "# Installed conventions",
    "",
    "This directory is managed by `coding-tooling conventions`. Do not edit these snapshots directly.",
    "Repository-specific rules and exceptions belong in `AGENTS.md`.",
    "",
    "## Rule briefing",
    "",
    "Read this section first. Open the linked managed source when a rule is relevant, ambiguous, or needs its full context.",
    "",
  ];
  if (briefings.length === 0) lines.push("No convention rules are installed.", "");
  else {
    for (const briefing of briefings) {
      const directive = briefing.directive ? ` — ${briefing.directive}` : "";
      lines.push(
        `- **${briefing.id} — ${briefing.title}**${directive} ([details](${briefing.path}))`,
      );
    }
    lines.push("");
  }
  lines.push("## Installed modules", "");
  for (const module of resolvedModules) {
    lines.push(`### ${module}`, "");
    for (const path of moduleSources.get(module) ?? []) lines.push(`- [${path}](${path})`);
    lines.push("");
  }
  lines.push("## Companion configuration assets", "");
  const allAssets = resolvedModules.flatMap((module) => moduleAssets.get(module) ?? []);
  if (allAssets.length === 0) lines.push("No companion configuration assets are installed.", "");
  else {
    for (const module of resolvedModules) {
      const assets = moduleAssets.get(module) ?? [];
      if (!assets.length) continue;
      lines.push(`### ${module}`, "");
      for (const path of assets) lines.push(`- [${path}](${path})`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildSnapshot(
  sourceRoot: string,
  registry: RegistryManifest,
  requestedModules: string[],
): Snapshot {
  const resolvedModules = resolveDependencies(registry, requestedModules);
  const files = new Map<string, string>();
  const moduleSources = new Map<string, string[]>();
  const moduleAssets = new Map<string, string[]>();
  const briefings: RuleBriefing[] = [];
  const seenRuleIds = new Set<string>();
  const installedConfigurations: InstalledConfiguration[] = [];

  for (const moduleName of resolvedModules) {
    const module = registry.modules[moduleName]!;
    const installedSources: string[] = [];
    const installedAssets: string[] = [];
    for (const source of module.sources) {
      for (const absolute of sourceFiles(sourceRoot, source)) {
        const sourcePath = relative(realpathSync(sourceRoot), absolute).split(sep).join("/");
        if (!isManagedPath(sourcePath))
          throw new Error(`Invalid convention source path: ${sourcePath}`);
        const targetPath = `modules/${moduleName}/${sourcePath}`;
        const content = readFileSync(absolute, "utf8");
        files.set(targetPath, content);
        installedSources.push(targetPath);
        for (const briefing of extractRuleBriefings(content, targetPath)) {
          if (seenRuleIds.has(briefing.id)) continue;
          seenRuleIds.add(briefing.id);
          briefings.push(briefing);
        }
      }
    }
    for (const asset of module.assets ?? []) {
      const absolute = assetFile(sourceRoot, asset);
      const sourcePath = relative(realpathSync(sourceRoot), absolute).split(sep).join("/");
      if (!isManagedPath(sourcePath))
        throw new Error(`Invalid convention asset path: ${sourcePath}`);
      const targetPath = `modules/${moduleName}/${sourcePath}`;
      files.set(targetPath, readFileSync(absolute, "utf8"));
      installedAssets.push(targetPath);
    }
    for (const configuration of module.configurations ?? []) {
      installedConfigurations.push({
        ...configuration,
        module: moduleName,
        path: `modules/${moduleName}/${configuration.path}`,
      });
    }
    moduleSources.set(moduleName, installedSources);
    moduleAssets.set(moduleName, installedAssets);
  }

  for (const configuration of installedConfigurations) {
    if (!seenRuleIds.has(configuration.rule)) {
      throw new Error(
        `Convention configuration references unknown installed rule: ${configuration.rule}`,
      );
    }
    if (!files.has(configuration.path)) {
      throw new Error(`Convention configuration asset was not installed: ${configuration.path}`);
    }
  }

  files.set(
    configurationManifestName,
    `${JSON.stringify({ schemaVersion: 1, configurations: installedConfigurations }, null, 2)}\n`,
  );
  files.set("index.md", indexContent(resolvedModules, moduleSources, moduleAssets, briefings));
  return { sourceRevision: revision(sourceRoot), requestedModules, resolvedModules, files };
}

function managedDestination(installRoot: string, path: string): string {
  if (!isManagedPath(path)) throw new Error(`Invalid managed convention path: ${path}`);
  const root = resolve(installRoot);
  const absolute = resolve(root, path);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`Managed convention path escapes install root: ${path}`);
  }
  return absolute;
}

function materialize(root: string, snapshot: Snapshot): ConventionLock {
  const installRoot = join(root, installDirectory);
  rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(installRoot, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [path, content] of snapshot.files) {
    const absolute = managedDestination(installRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    hashes[path] = hash(content);
  }
  const lock: ConventionLock = {
    schemaVersion: 1,
    sourceRevision: snapshot.sourceRevision,
    requestedModules: snapshot.requestedModules,
    resolvedModules: snapshot.resolvedModules,
    files: hashes,
  };
  writeJson(join(root, lockName), lock);
  return lock;
}

function currentFileHashes(root: string): Record<string, string> {
  const installRoot = join(root, installDirectory);
  if (!existsSync(installRoot)) return {};
  const result: Record<string, string> = {};
  for (const absolute of walkFiles(installRoot, 20).sort()) {
    const path = relative(installRoot, absolute).split(sep).join("/");
    if (!isManagedPath(path)) continue;
    result[path] = hash(readFileSync(absolute, "utf8"));
  }
  return result;
}

function hashDiff(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...paths].filter((path) => expected[path] !== actual[path]).sort();
}

function snapshotHashes(snapshot: Snapshot): Record<string, string> {
  return Object.fromEntries([...snapshot.files].map(([path, content]) => [path, hash(content)]));
}

function envelope(
  operation: ResultOperation,
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

function sourceFor(options: RegistryOptions): { root: string; registry: RegistryManifest } {
  const source = resolveConventionSource({
    root: options.root,
    conventionsRoot: options.conventionsRoot,
    registryPath: options.registryPath,
  });
  if (!source) {
    throw new Error(
      "coding-agent-conventions is unavailable; provide --conventions-root or register a local checkout before init/add/diff/update",
    );
  }
  return { root: source.root, registry: loadRegistry(source.root) };
}

export function conventionRegistryCommand(
  action: "init" | "add" | "check" | "diff" | "update",
  modules: string[],
  options: RegistryOptions,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root);
  try {
    if (action === "check") {
      const consumer = loadConsumer(root);
      const lock = loadLock(root);
      if (!consumer) {
        return envelope("conventions-check", "failed", started, { root }, [
          {
            code: "conventions-manifest-missing",
            message: `${manifestName} is missing or invalid`,
          },
        ]);
      }
      if (!lock) {
        return envelope("conventions-check", "failed", started, { root }, [
          { code: "conventions-lock-missing", message: `${lockName} is missing or invalid` },
        ]);
      }
      const drift = hashDiff(lock.files, currentFileHashes(root));
      const selectionDrift =
        JSON.stringify(consumer.modules) !== JSON.stringify(lock.requestedModules);
      const diagnostics: Diagnostic[] = drift.map((path) => ({
        code: "conventions-managed-file-drift",
        message: `Managed convention file differs from the lock: ${path}`,
      }));
      if (selectionDrift) {
        diagnostics.push({
          code: "conventions-selection-drift",
          message: `${manifestName} module selection differs from ${lockName}`,
        });
      }
      return envelope(
        "conventions-check",
        diagnostics.length ? "failed" : "passed",
        started,
        {
          root,
          requestedModules: consumer.modules,
          resolvedModules: lock.resolvedModules,
          sourceRevision: lock.sourceRevision,
          drift,
        },
        diagnostics,
      );
    }

    const existing = loadConsumer(root);
    if (action === "init" && existing) {
      return envelope("conventions-init", "passed", started, {
        root,
        manifest: join(root, manifestName),
        modules: existing.modules,
        unchanged: true,
      });
    }

    const source = sourceFor({ ...options, root });
    if (action === "init") {
      const requested = resolveRequestedModules(source.registry, modules, options.profile);
      const snapshot = buildSnapshot(source.root, source.registry, requested);
      const consumer: ConsumerManifest = {
        schemaVersion: 1,
        registry: "coding-agent-conventions",
        modules: requested,
      };
      materialize(root, snapshot);
      writeJson(join(root, manifestName), consumer);
      return envelope("conventions-init", "passed", started, {
        root,
        modules: requested,
        profile: options.profile,
      });
    }

    if (!existing) {
      return envelope(`conventions-${action}`, "failed", started, { root }, [
        {
          code: "conventions-manifest-missing",
          message: `Run coding-tooling conventions init before ${action}`,
        },
      ]);
    }

    if (action === "add") {
      const requested = resolveRequestedModules(
        source.registry,
        [...existing.modules, ...modules],
        options.profile,
      );
      const snapshot = buildSnapshot(source.root, source.registry, requested);
      const consumer: ConsumerManifest = { ...existing, modules: requested };
      const lock = materialize(root, snapshot);
      writeJson(join(root, manifestName), consumer);
      return envelope("conventions-add", "passed", started, {
        root,
        requestedModules: requested,
        resolvedModules: lock.resolvedModules,
        sourceRevision: lock.sourceRevision,
      });
    }

    const snapshot = buildSnapshot(source.root, source.registry, existing.modules);
    if (action === "diff") {
      const changed = hashDiff(snapshotHashes(snapshot), currentFileHashes(root));
      const lock = loadLock(root);
      return envelope("conventions-diff", "passed", started, {
        root,
        installedRevision: lock?.sourceRevision,
        availableRevision: snapshot.sourceRevision,
        changed,
        updateAvailable:
          Boolean(lock && lock.sourceRevision !== snapshot.sourceRevision) || changed.length > 0,
      });
    }

    const lock = materialize(root, snapshot);
    return envelope("conventions-update", "passed", started, {
      root,
      requestedModules: existing.modules,
      resolvedModules: lock.resolvedModules,
      sourceRevision: lock.sourceRevision,
    });
  } catch (error) {
    return envelope(`conventions-${action}`, "error", started, { root }, [
      {
        code: "conventions-registry-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
