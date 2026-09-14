import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type JavaScriptSourcePackage = {
  package: string;
  path?: string;
};

export type JavaScriptSourceRepository = {
  git: string;
  rev: string;
  localPath: string;
  packages: JavaScriptSourcePackage[];
};

export type JavaScriptSourceConfig = {
  localOnly: true;
  repositories: JavaScriptSourceRepository[];
};

type PackageManifest = {
  name?: unknown;
  files?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

type SourcePackage = {
  packageName: string;
  repository: JavaScriptSourceRepository;
  repositoryRoot: string;
  packageRoot: string;
  manifest: PackageManifest;
  sourceDependencies: string[];
};

type JavaScriptSourceState = {
  schemaVersion: 1;
  packages: Array<{
    package: string;
    git: string;
    revision: string;
    sourceDir: string;
  }>;
};

const stateRelativePath = join("node_modules", ".coding-tooling-source-deps", "javascript.json");

function exactRevision(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

export function parseJavaScriptSourceConfig(
  value: unknown,
  configPath: string,
): JavaScriptSourceConfig | null {
  if (value === undefined) return null;
  const javascript = record(value, `javascript must be an object: ${configPath}`);
  if (javascript.localOnly !== true) {
    throw new Error(
      `JavaScript source dependencies currently require javascript.localOnly: true: ${configPath}`,
    );
  }
  if (!Array.isArray(javascript.repositories)) {
    throw new Error(`javascript.repositories must be an array: ${configPath}`);
  }

  const seenRepositories = new Set<string>();
  const seenPackages = new Set<string>();
  const repositories = javascript.repositories.map((candidate, index) => {
    const repository = record(
      candidate,
      `Invalid JavaScript source repository at index ${index}: ${configPath}`,
    );
    const git = requireString(
      repository.git,
      `Every JavaScript source repository requires git, rev, localPath, and packages: ${configPath}`,
    );
    const rev = requireString(
      repository.rev,
      `Every JavaScript source repository requires git, rev, localPath, and packages: ${configPath}`,
    );
    if (!exactRevision(rev)) {
      throw new Error(
        `JavaScript source repository ${git} requires an exact 40-character revision`,
      );
    }
    const localPath = requireString(
      repository.localPath,
      `JavaScript source repository ${git} requires localPath: ${configPath}`,
    );
    const repositoryKey = git.replace(/\.git$/i, "").toLowerCase();
    if (seenRepositories.has(repositoryKey)) {
      throw new Error(`JavaScript source repository is declared more than once: ${git}`);
    }
    seenRepositories.add(repositoryKey);
    if (!Array.isArray(repository.packages) || repository.packages.length === 0) {
      throw new Error(`JavaScript source repository ${git} must declare at least one package`);
    }
    const packages = repository.packages.map((packageCandidate, packageIndex) => {
      const packageRecord = record(
        packageCandidate,
        `Invalid JavaScript package at ${git} index ${packageIndex}: ${configPath}`,
      );
      const packageName = requireString(
        packageRecord.package,
        `Every JavaScript source package requires package: ${configPath}`,
      );
      if (seenPackages.has(packageName)) {
        throw new Error(`Duplicate JavaScript source package: ${packageName}`);
      }
      seenPackages.add(packageName);
      const packagePath =
        packageRecord.path === undefined
          ? undefined
          : requireString(
              packageRecord.path,
              `JavaScript package path must be a string for ${packageName}: ${configPath}`,
            );
      return { package: packageName, ...(packagePath ? { path: packagePath } : {}) };
    });
    packages.sort((left, right) => left.package.localeCompare(right.package));
    return { git, rev: rev.toLowerCase(), localPath, packages };
  });
  repositories.sort((left, right) => left.git.localeCompare(right.git));
  return { localOnly: true, repositories };
}

function command(command: string, args: string[], cwd: string, capture = false): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const stderr = capture && typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}${stderr ? `: ${stderr}` : ""}`);
  }
  return capture && typeof result.stdout === "string" ? result.stdout : "";
}

function localRevision(path: string): string {
  const revision = command("git", ["rev-parse", "HEAD"], path, true).trim().toLowerCase();
  if (!exactRevision(revision)) throw new Error(`Cannot read exact Git revision for ${path}`);
  return revision;
}

function containedPath(root: string, candidate: string, label: string): string {
  const target = resolve(root, candidate);
  const relation = relative(root, target);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  ) {
    return target;
  }
  throw new Error(`${label} escapes its source repository: ${candidate}`);
}

function packageManifest(path: string, expectedName: string): PackageManifest {
  const manifestPath = join(path, "package.json");
  if (!existsSync(manifestPath))
    throw new Error(`Missing package.json for ${expectedName}: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  if (manifest.name !== expectedName) {
    throw new Error(
      `JavaScript source package at ${path} is ${String(manifest.name ?? "unnamed")}, expected ${expectedName}`,
    );
  }
  return manifest;
}

function manifestDependencyNames(manifest: PackageManifest): string[] {
  const result = new Set<string>();
  for (const dependencies of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const name of Object.keys(dependencies)) result.add(name);
  }
  return [...result].sort();
}

function sourcePackages(root: string, config: JavaScriptSourceConfig): SourcePackage[] {
  const configuredNames = new Set(
    config.repositories.flatMap((repository) => repository.packages.map((entry) => entry.package)),
  );
  const result: SourcePackage[] = [];
  for (const repository of config.repositories) {
    const repositoryRoot = resolve(root, repository.localPath);
    if (!existsSync(repositoryRoot)) {
      throw new Error(
        `Local JavaScript source repository ${repository.git} is missing at ${repositoryRoot}; local-only source mode never fetches repository sources`,
      );
    }
    const revision = localRevision(repositoryRoot);
    if (revision !== repository.rev) {
      throw new Error(
        `Local JavaScript source repository ${repository.git} is at ${revision}, expected ${repository.rev}`,
      );
    }
    for (const entry of repository.packages) {
      const packageRoot = containedPath(
        repositoryRoot,
        entry.path ?? ".",
        `JavaScript source package ${entry.package}`,
      );
      const manifest = packageManifest(packageRoot, entry.package);
      result.push({
        packageName: entry.package,
        repository,
        repositoryRoot,
        packageRoot,
        manifest,
        sourceDependencies: manifestDependencyNames(manifest).filter((name) =>
          configuredNames.has(name),
        ),
      });
    }
  }
  return result.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function buildOrder(packages: SourcePackage[]): SourcePackage[] {
  const byName = new Map(packages.map((entry) => [entry.packageName, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: SourcePackage[] = [];

  function visit(packageName: string): void {
    if (visited.has(packageName)) return;
    if (visiting.has(packageName)) {
      throw new Error(`JavaScript source dependency cycle includes ${packageName}`);
    }
    const entry = byName.get(packageName);
    if (!entry) return;
    visiting.add(packageName);
    for (const dependency of entry.sourceDependencies) visit(dependency);
    visiting.delete(packageName);
    visited.add(packageName);
    result.push(entry);
  }

  for (const packageName of [...byName.keys()].sort()) visit(packageName);
  return result;
}

function packageFiles(entry: SourcePackage): string[] {
  if (entry.manifest.files === undefined) return ["dist"];
  if (!Array.isArray(entry.manifest.files) || entry.manifest.files.length === 0) {
    throw new Error(`${entry.packageName} package files must be a non-empty array`);
  }
  return entry.manifest.files.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`${entry.packageName} package files must contain non-empty strings`);
    }
    if (/[*?{}[\]]/.test(candidate)) {
      throw new Error(
        `${entry.packageName} package file ${candidate} uses a glob; source materialization requires concrete package paths`,
      );
    }
    containedPath(entry.packageRoot, candidate, `${entry.packageName} package file`);
    return candidate;
  });
}

function targetDirectory(root: string, packageName: string): string {
  return join(root, "node_modules", ...packageName.split("/"));
}

function materializePackage(root: string, entry: SourcePackage): void {
  const target = targetDirectory(root, entry.packageName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), `${JSON.stringify(entry.manifest, null, 2)}\n`);
  for (const packageFile of packageFiles(entry)) {
    const source = join(entry.packageRoot, packageFile);
    if (!existsSync(source)) {
      throw new Error(`${entry.packageName} source build did not create package file ${source}`);
    }
    cpSync(source, join(target, packageFile), { recursive: true, force: true });
  }
}

function statePath(root: string): string {
  return join(root, stateRelativePath);
}

function readState(root: string): JavaScriptSourceState | null {
  const path = statePath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as JavaScriptSourceState;
    return parsed.schemaVersion === 1 && Array.isArray(parsed.packages) ? parsed : null;
  } catch {
    return null;
  }
}

export function activateJavaScriptSourceDependencies(
  root: string,
  config: JavaScriptSourceConfig,
): Record<string, unknown> {
  command("bun", ["install", "--frozen-lockfile", "--force"], root);
  const packages = sourcePackages(root, config);
  const ordered = buildOrder(packages);
  const touchedRepositories = new Set<string>();
  let primaryError: unknown;

  try {
    for (const entry of ordered) {
      if (!touchedRepositories.has(entry.repositoryRoot)) {
        command("bun", ["install", "--frozen-lockfile", "--force"], entry.repositoryRoot);
        touchedRepositories.add(entry.repositoryRoot);
      }
      for (const dependencyName of entry.sourceDependencies) {
        const dependency = packages.find((candidate) => candidate.packageName === dependencyName);
        if (dependency) materializePackage(entry.repositoryRoot, dependency);
      }
      if (typeof entry.manifest.scripts?.build !== "string") {
        throw new Error(
          `${entry.packageName} source checkout has no build script: ${entry.packageRoot}`,
        );
      }
      command("bun", ["run", "build"], entry.packageRoot);
      for (const packageFile of packageFiles(entry)) {
        const source = join(entry.packageRoot, packageFile);
        if (!existsSync(source)) {
          throw new Error(
            `${entry.packageName} source build did not create package file ${source}`,
          );
        }
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    for (const repositoryRoot of [...touchedRepositories].reverse()) {
      try {
        command("bun", ["install", "--frozen-lockfile", "--force"], repositoryRoot);
      } catch (error) {
        primaryError ??= error;
      }
    }
  }
  if (primaryError) throw primaryError;

  for (const entry of ordered) materializePackage(root, entry);
  const state: JavaScriptSourceState = {
    schemaVersion: 1,
    packages: ordered.map((entry) => ({
      package: entry.packageName,
      git: entry.repository.git,
      revision: entry.repository.rev,
      sourceDir: entry.packageRoot,
    })),
  };
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return {
    active: true,
    statePath: path,
    packages: state.packages,
    buildOrder: ordered.map((entry) => entry.packageName),
  };
}

export function statusJavaScriptSourceDependencies(
  root: string,
  config: JavaScriptSourceConfig,
): Record<string, unknown> {
  const state = readState(root);
  const expected = config.repositories
    .flatMap((repository) =>
      repository.packages.map((entry) => ({
        package: entry.package,
        revision: repository.rev,
      })),
    )
    .sort((left, right) => left.package.localeCompare(right.package));
  const observed = new Map((state?.packages ?? []).map((entry) => [entry.package, entry]));
  const packages = expected.map((entry) => {
    const active = observed.get(entry.package);
    const manifestPath = join(targetDirectory(root, entry.package), "package.json");
    let identityMatches = false;
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
        identityMatches = manifest.name === entry.package;
      } catch {
        identityMatches = false;
      }
    }
    return {
      package: entry.package,
      expectedRevision: entry.revision,
      activeRevision: active?.revision ?? null,
      identityMatches,
      active: active?.revision === entry.revision && identityMatches,
    };
  });
  return {
    active: packages.every((entry) => entry.active) && packages.length === expected.length,
    statePath: statePath(root),
    packages,
  };
}

export function smokeJavaScriptSourceDependencies(
  root: string,
  config: JavaScriptSourceConfig,
): Record<string, unknown> {
  const status = statusJavaScriptSourceDependencies(root, config);
  if (status.active !== true)
    throw new Error("JavaScript source dependency mode is not fully active");
  const packageNames = config.repositories
    .flatMap((repository) => repository.packages.map((entry) => entry.package))
    .sort();
  for (const packageName of packageNames) {
    command(
      "bun",
      [
        "-e",
        `import(${JSON.stringify(packageName)}).catch((error) => { console.error(error); process.exit(1); })`,
      ],
      root,
    );
  }
  return { active: true, packages: packageNames };
}

export function deactivateJavaScriptSourceDependencies(
  root: string,
  config: JavaScriptSourceConfig,
): Record<string, unknown> {
  const packages = config.repositories
    .flatMap((repository) => repository.packages.map((entry) => entry.package))
    .sort();
  for (const packageName of packages) {
    rmSync(targetDirectory(root, packageName), { recursive: true, force: true });
  }
  rmSync(statePath(root), { force: true });
  command("bun", ["install", "--frozen-lockfile", "--force"], root);
  return { active: false, statePath: statePath(root), packages };
}
