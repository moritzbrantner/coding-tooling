import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type CommandResult = {
  command: string[];
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export function runCommand(
  command: string,
  args: string[] = [],
  cwd = process.cwd(),
  inherit = false,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    shell: false,
  });

  return {
    command: [command, ...args],
    status: result.status ?? (result.error ? 127 : 0),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error?.message,
  };
}

export function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
  });
  return !result.error;
}

export function repositoryRoot(cwd = process.cwd()): string {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  return result.status === 0 ? result.stdout.trim() : resolve(cwd);
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "bin",
  "build",
  "dist",
  "fixtures",
  "node_modules",
  "obj",
  "target",
]);

export function walkFiles(root: string, maxDepth = 3): string[] {
  const files: string[] = [];

  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(root, 0);
  return files;
}

export function relativePosix(root: string, path: string): string {
  const value = relative(root, path);
  if (!value) return ".";
  return value.split(sep).join("/");
}

export function pathName(path: string): string {
  return basename(path) || basename(dirname(path));
}

export function findNearestFile(start: string, root: string, names: string[]): string | undefined {
  let current = resolve(start);
  const boundary = resolve(root);

  while (true) {
    for (const name of names) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }

    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(boundary)) return undefined;
    current = parent;
  }
}
