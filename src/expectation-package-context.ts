import { existsSync } from "node:fs";
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
  javaScriptSourceFiles: string[];
  usesBun: boolean;
};

export type DetectorContext = {
  root: string;
  packages: PackageInfo[];
};

const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const typeScriptSourceFilePattern = /\.(?:[cm]?ts|tsx)$/;
const javaScriptSourceFilePattern = /\.(?:[cm]?js|jsx)$/;
const storyFilePattern = /\.(?:stories|story)\.(?:[cm]?[jt]sx?)$/;
const fixtureFilePattern = /\.(?:fixture|fixtures)\.(?:[cm]?[jt]sx?)$/;
const supportDirectoryPattern = /^src\/(?:test|tests|testing|__tests__)\/|\/stories\//;

export function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isProductionSource(local: string, sourcePattern: RegExp): boolean {
  if (!local.startsWith("src/") || !sourcePattern.test(local)) return false;
  if (testFilePattern.test(local)) return false;
  if (storyFilePattern.test(local) || fixtureFilePattern.test(local)) return false;
  return !supportDirectoryPattern.test(local);
}

function isProductionTypeScriptSource(local: string): boolean {
  return !local.endsWith(".d.ts") && isProductionSource(local, typeScriptSourceFilePattern);
}

function isProductionJavaScriptSource(local: string): boolean {
  return isProductionSource(local, javaScriptSourceFilePattern);
}

function packageInfos(root: string): PackageInfo[] {
  const files = walkFiles(root, 8).sort();
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
    const javaScriptSourceFiles = packageFiles.filter((path) =>
      isProductionJavaScriptSource(normalizePath(relative(directory, path))),
    );
    const testFiles = packageFiles.filter((path) => testFilePattern.test(normalizePath(path)));
    result.push({
      directory,
      path: relativePosix(root, directory),
      manifestPath,
      manifest,
      testFiles,
      sourceFiles,
      javaScriptSourceFiles,
      usesBun:
        existsSync(join(directory, "bun.lock")) ||
        existsSync(join(directory, "bun.lockb")) ||
        existsSync(join(root, "bun.lock")) ||
        existsSync(join(root, "bun.lockb")),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function createDetectorContext(root: string): DetectorContext {
  return { root, packages: packageInfos(root) };
}
