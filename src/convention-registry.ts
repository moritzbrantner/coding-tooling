import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { resolveConventionSource } from "./conventions.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readJson, runCommand, walkFiles } from "./shared.ts";

type RegistryModule = {
  description?: string;
  sources: string[];
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

type Snapshot = {
  sourceRevision: string;
  requestedModules: string[];
  resolvedModules: string[];
  files: Map<string, string>;
};

const manifestName = "conventions.json";
const lockName = "conventions.lock.json";
const installDirectory = ".conventions";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function revision(root: string): string {
  const result = runCommand("git", ["rev-parse", "HEAD"], root);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : "unversioned";
}

function loadRegistry(sourceRoot: string): RegistryManifest {
  const path = join(sourceRoot, "registry", "registry.json");
  const manifest = readJson<RegistryManifest>(path);
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.modules) {
    throw new Error(`Invalid convention registry manifest: ${path}`);
  }
  return manifest;
}

function loadConsumer(root: string): ConsumerManifest | undefined {
  return readJson<ConsumerManifest>(join(root, manifestName));
}

function loadLock(root: string): ConventionLock | undefined {
  return readJson<ConventionLock>(join(root, lockName));
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
    if (!registry.modules[module]) throw new Error(`Unknown convention module: ${module}`);
  }
  return requested;
}

function resolveDependencies(registry: RegistryManifest, requested: string[]): string[] {
  const resolved: string[] = [];
  const active = new Set<string>();
  const done = new Set<string>();

  function visit(name: string): void {
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

function sourceFiles(sourceRoot: string, source: string): string[] {
  const absolute = resolve(sourceRoot, source);
  const boundary = `${resolve(sourceRoot)}${sep}`;
  if (absolute !== resolve(sourceRoot) && !absolute.startsWith(boundary)) {
    throw new Error(`Convention source escapes registry root: ${source}`);
  }
  if (!existsSync(absolute)) throw new Error(`Convention source does not exist: ${source}`);
  if (statSync(absolute).isFile()) return [absolute];
  return walkFiles(absolute, 12).filter((file) => file.endsWith(".md")).sort();
}

function indexContent(resolvedModules: string[], moduleFiles: Map<string, string[]>): string {
  const lines = [
    "# Installed conventions",
    "",
    "This directory is managed by `coding-tooling conventions`. Do not edit these snapshots directly.",
    "Repository-specific rules and exceptions belong in `AGENTS.md`.",
    "",
  ];
  for (const module of resolvedModules) {
    lines.push(`## ${module}`, "");
    for (const path of moduleFiles.get(module) ?? []) lines.push(`- [${path}](${path})`);
    lines.push("");
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
  const moduleFiles = new Map<string, string[]>();

  for (const moduleName of resolvedModules) {
    const module = registry.modules[moduleName];
    const installed: string[] = [];
    for (const source of module.sources) {
      for (const absolute of sourceFiles(sourceRoot, source)) {
        const sourcePath = relative(sourceRoot, absolute).split(sep).join("/");
        const targetPath = `modules/${moduleName}/${sourcePath}`;
        files.set(targetPath, readFileSync(absolute, "utf8"));
        installed.push(targetPath);
      }
    }
    moduleFiles.set(moduleName, installed);
  }

  files.set("index.md", indexContent(resolvedModules, moduleFiles));
  return {
    sourceRevision: revision(sourceRoot),
    requestedModules,
    resolvedModules,
    files,
  };
}

function materialize(root: string, snapshot: Snapshot): ConventionLock {
  const installRoot = join(root, installDirectory);
  rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(installRoot, { recursive: true });

  const hashes: Record<string, string> = {};
  for (const [path, content] of snapshot.files) {
    const absolute = join(installRoot, path);
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
  operation: string,
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
      if (!consumer || consumer.schemaVersion !== 1) {
        return envelope("conventions-check", "failed", started, { root }, [
          { code: "conventions-manifest-missing", message: `${manifestName} is missing or invalid` },
        ]);
      }
      if (!lock || lock.schemaVersion !== 1) {
        return envelope("conventions-check", "failed", started, { root }, [
          { code: "conventions-lock-missing", message: `${lockName} is missing or invalid` },
        ]);
      }
      const drift = hashDiff(lock.files, currentFileHashes(root));
      const selectionDrift = JSON.stringify(consumer.modules) !== JSON.stringify(lock.requestedModules);
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

    const source = sourceFor({ ...options, root });
    const existing = loadConsumer(root);

    if (action === "init") {
      if (existing) {
        return envelope("conventions-init", "passed", started, {
          root,
          manifest: join(root, manifestName),
          modules: existing.modules,
          unchanged: true,
        });
      }
      const requested = resolveRequestedModules(source.registry, modules, options.profile);
      const consumer: ConsumerManifest = {
        schemaVersion: 1,
        registry: "coding-agent-conventions",
        modules: requested,
      };
      writeJson(join(root, manifestName), consumer);
      if (requested.length) materialize(root, buildSnapshot(source.root, source.registry, requested));
      return envelope("conventions-init", "passed", started, {
        root,
        modules: requested,
        profile: options.profile,
      });
    }

    if (!existing || existing.schemaVersion !== 1) {
      return envelope(`conventions-${action}`, "failed", started, { root }, [
        {
          code: "conventions-manifest-missing",
          message: `Run coding-tooling conventions init before ${action}`,
        },
      ]);
    }

    if (action === "add") {
      const requested = resolveRequestedModules(source.registry, [...existing.modules, ...modules], options.profile);
      const consumer: ConsumerManifest = { ...existing, modules: requested };
      writeJson(join(root, manifestName), consumer);
      const lock = materialize(root, buildSnapshot(source.root, source.registry, requested));
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
