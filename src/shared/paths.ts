import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".expo",
  "coverage",
  "fixtures",
]);

export function findRepositoryRoot(start = process.cwd()): string | null {
  let current = resolve(start);

  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function listDirectories(root: string, maxDepth = 2): string[] {
  const output: string[] = [root];

  function visit(directory: string, depth: number): void {
    if (depth >= maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const child = join(directory, entry.name);
      output.push(child);
      visit(child, depth + 1);
    }
  }

  visit(root, 0);
  return output;
}

export function hasAnyFile(directory: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(directory, name)));
}

export function hasDotnetProject(directory: string): boolean {
  return readdirSync(directory).some(
    (name) => name.endsWith(".csproj") || name.endsWith(".sln") || name.endsWith(".slnx"),
  );
}

export function isWritablePath(path: string): boolean {
  try {
    const stats = statSync(path);
    return Boolean(stats.mode & 0o222);
  } catch {
    return false;
  }
}
