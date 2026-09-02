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
  testFiles: string[];
  sourceFiles: string[];
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

function tomlSection(content: string, section: string): string | undefined {
  const header = new RegExp(`^\\s*\\[${section}\\]\\s*$`, "m").exec(content);
  if (!header || header.index === undefined) return undefined;
  const rest = content.slice(header.index + header[0].length);
  const next = /^\s*\[/m.exec(rest);
  return next?.index === undefined ? rest : rest.slice(0, next.index);
}

function rustCrateName(manifestPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(manifestPath, "utf8");
  } catch {
    return undefined;
  }

  const nameFrom = (section: string): string | undefined =>
    /^\s*name\s*=\s*["']([^"']+)["']/m.exec(tomlSection(content, section) ?? "")?.[1];
  const name = nameFrom("lib") ?? nameFrom("package");
  return name?.replaceAll("-", "_");
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
    const sourceFiles = packageFiles.filter((path) =>
      isProductionRustSource(normalizePath(relative(directory, path))),
    );
    const testFiles = packageFiles.filter((path) => {
      const local = normalizePath(relative(directory, path));
      return local.startsWith("tests/") && local.endsWith(".rs");
    });
    result.push({
      directory,
      path: relativePosix(root, directory),
      manifestPath,
      crateName: rustCrateName(manifestPath),
      testFiles,
      sourceFiles,
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
