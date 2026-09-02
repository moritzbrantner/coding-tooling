import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { readJson, relativePosix, walkFiles } from "./shared.ts";

export type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
};

export type PackageInfo = {
  directory: string;
  path: string;
  manifestPath: string;
  manifest: PackageManifest;
  testFiles: string[];
  sourceFiles: string[];
  usesBun: boolean;
};

export type RustPackageInfo = {
  directory: string;
  path: string;
  manifestPath: string;
  crateName?: string;
  integrationTestRoots: string[];
  rustFiles: string[];
  sourceFiles: string[];
  hasLockfile: boolean;
};

export type DetectorContext = {
  root: string;
  packages: PackageInfo[];
  rustPackages: RustPackageInfo[];
};

const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const sourceFilePattern = /\.(?:[cm]?ts|tsx)$/;
const storyFilePattern = /\.(?:stories|story)\.(?:[cm]?[jt]sx?)$/;
const fixtureFilePattern = /\.(?:fixture|fixtures)\.(?:[cm]?[jt]sx?)$/;

export function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isProductionTypeScriptSource(local: string): boolean {
  if (!local.startsWith("src/") || !sourceFilePattern.test(local)) return false;
  if (local.endsWith(".d.ts") || testFilePattern.test(local)) return false;
  if (storyFilePattern.test(local) || fixtureFilePattern.test(local)) return false;
  return !/^src\/(?:test|tests|__tests__)\//.test(local);
}

function packageInfos(root: string, files: string[]): PackageInfo[] {
  const manifestPaths = files.filter((path) => basename(path) === "package.json");
  const packageDirectories = manifestPaths
    .map((path) => dirname(path))
    .sort((left, right) => right.length - left.length);
  const result: PackageInfo[] = [];
  for (const manifestPath of manifestPaths) {
    const manifest = readJson<PackageManifest>(manifestPath);
    if (!manifest) continue;
    const directory = dirname(manifestPath);
    const packageFiles = files.filter((path) => {
      const owner = packageDirectories.find(
        (candidate) =>
          path === join(candidate, "package.json") || path.startsWith(`${candidate}${sep}`),
      );
      return owner === directory;
    });
    const sourceFiles = packageFiles.filter((path) =>
      isProductionTypeScriptSource(normalizePath(relative(directory, path))),
    );
    const testFiles = packageFiles.filter((path) => testFilePattern.test(normalizePath(path)));
    result.push({
      directory,
      path: relativePosix(root, directory),
      manifestPath,
      manifest,
      testFiles,
      sourceFiles,
      usesBun:
        existsSync(join(directory, "bun.lock")) ||
        existsSync(join(directory, "bun.lockb")) ||
        existsSync(join(root, "bun.lock")) ||
        existsSync(join(root, "bun.lockb")),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function tomlSection(content: string, section: string): string | undefined {
  const header = new RegExp(`^\\s*\\[${section}\\]\\s*$`, "m").exec(content);
  if (!header || header.index === undefined) return undefined;
  const rest = content.slice(header.index + header[0].length);
  const next = /^\s*\[/m.exec(rest);
  return next?.index === undefined ? rest : rest.slice(0, next.index);
}

function tomlArraySections(content: string, section: string): string[] {
  const result: string[] = [];
  const lines = content.split(/\r?\n/);
  let collecting = false;
  let body: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (collecting) result.push(body.join("\n"));
      collecting = trimmed === `[[${section}]]`;
      body = [];
      continue;
    }
    if (collecting) body.push(line);
  }
  if (collecting) result.push(body.join("\n"));
  return result;
}

function tomlString(content: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(content)?.[1];
}

type RustManifestInfo = {
  crateName?: string;
  autotests: boolean;
  explicitTestPaths: string[];
};

function rustManifestInfo(manifestPath: string): RustManifestInfo {
  const content = readText(manifestPath) ?? "";
  const packageSection = tomlSection(content, "package") ?? "";
  const librarySection = tomlSection(content, "lib") ?? "";
  const packageName = tomlString(packageSection, "name");
  const libraryName = tomlString(librarySection, "name");
  const autotests = !/^\s*autotests\s*=\s*false\s*$/m.test(packageSection);
  const explicitTestPaths = tomlArraySections(content, "test")
    .map((section) => {
      const path = tomlString(section, "path");
      if (path) return path;
      const name = tomlString(section, "name");
      return name ? `tests/${name}.rs` : undefined;
    })
    .filter((path): path is string => path !== undefined);

  return {
    crateName: (libraryName ?? packageName)?.replaceAll("-", "_"),
    autotests,
    explicitTestPaths,
  };
}

function hasCargoLock(root: string, directory: string): boolean {
  let current = directory;
  while (true) {
    if (existsSync(join(current, "Cargo.lock"))) return true;
    if (current === root) return false;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(`${root}${sep}`)) return false;
    current = parent;
  }
}

function isProductionRustSource(local: string): boolean {
  return local.startsWith("src/") && local.endsWith(".rs");
}

function rustPackageInfos(root: string, files: string[]): RustPackageInfo[] {
  const manifestPaths = files.filter((path) => basename(path) === "Cargo.toml");
  const packageDirectories = manifestPaths
    .map((path) => dirname(path))
    .sort((left, right) => right.length - left.length);
  const result: RustPackageInfo[] = [];

  for (const manifestPath of manifestPaths) {
    const directory = dirname(manifestPath);
    const packageFiles = files.filter((path) => {
      const owner = packageDirectories.find(
        (candidate) =>
          path === join(candidate, "Cargo.toml") || path.startsWith(`${candidate}${sep}`),
      );
      return owner === directory;
    });
    const rustFiles = packageFiles.filter((path) => path.endsWith(".rs"));
    const rustFileSet = new Set(rustFiles);
    const sourceFiles = rustFiles.filter((path) =>
      isProductionRustSource(normalizePath(relative(directory, path))),
    );
    const manifest = rustManifestInfo(manifestPath);
    const automaticTestRoots = manifest.autotests
      ? rustFiles.filter((path) => /^tests\/[^/]+\.rs$/.test(normalizePath(relative(directory, path))))
      : [];
    const explicitTestRoots = manifest.explicitTestPaths
      .map((path) => join(directory, path))
      .filter((path) => rustFileSet.has(path));
    const integrationTestRoots = [...new Set([...automaticTestRoots, ...explicitTestRoots])].sort();

    result.push({
      directory,
      path: relativePosix(root, directory),
      manifestPath,
      crateName: manifest.crateName,
      integrationTestRoots,
      rustFiles,
      sourceFiles,
      hasLockfile: hasCargoLock(root, directory),
    });
  }

  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function createDetectorContext(root: string): DetectorContext {
  const files = walkFiles(root, 8).sort();
  return {
    root,
    packages: packageInfos(root, files),
    rustPackages: rustPackageInfos(root, files),
  };
}
