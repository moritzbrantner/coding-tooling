import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";

import { readJson, runCommand } from "./shared.ts";

import type { Normalizer } from "./normalization.ts";

export type NormalizationSelectionRequest =
  | { mode: "paths"; paths: string[]; cwd?: string }
  | { mode: "staged" }
  | { mode: "changed"; base?: string };

export type NormalizationSelection = {
  mode: NormalizationSelectionRequest["mode"];
  base?: string;
  /** Repository-relative POSIX paths offered to the scoped normalizers. */
  files: string[];
  /** Staged files that also have unstaged edits; left untouched so unstaged work is never staged. */
  partiallyStaged: string[];
  /** Requested paths that are outside the repository or not regular files. */
  ignored: string[];
};

export type ScopedNormalizer = Normalizer & { files: string[] };

export type UnscopableNormalizer = {
  id: string;
  files: string[];
  reason: string;
};

const oxfmtExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".json5",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".yaml",
  ".yml",
  ".toml",
  ".graphql",
]);
const oxlintExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
]);
const dotnetExtensions = new Set([".cs", ".vb", ".fs"]);
// Oxc options that consume the following token; every other flag is boolean.
const oxcValueFlags = new Set([
  "-c",
  "--config",
  "--tsconfig",
  "-f",
  "--format",
  "--max-warnings",
  "--ignore-path",
  "--ignore-pattern",
  "--threads",
  "-A",
  "--allow",
  "-W",
  "--warn",
  "-D",
  "--deny",
]);
const packageManagers = new Set(["bun", "npm", "pnpm", "yarn"]);

function gitPaths(root: string, args: string[]): string[] {
  const result = runCommand("git", [...args, "-z"], root);
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.error}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

export function selectNormalizationFiles(
  root: string,
  request: NormalizationSelectionRequest,
): NormalizationSelection {
  const ignored: string[] = [];
  let candidates: string[];
  let partiallyStaged: string[] = [];

  if (request.mode === "paths") {
    const cwd = request.cwd ?? process.cwd();
    candidates = [];
    for (const path of request.paths) {
      const local = relative(root, resolve(cwd, path));
      if (local.startsWith("..") || isAbsolute(local)) ignored.push(path);
      else candidates.push(toPosix(local));
    }
  } else if (request.mode === "staged") {
    const staged = gitPaths(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    const unstaged = new Set(gitPaths(root, ["diff", "--name-only"]));
    partiallyStaged = staged.filter((path) => unstaged.has(path));
    candidates = staged.filter((path) => !unstaged.has(path));
  } else {
    candidates = [
      ...gitPaths(root, ["diff", "--name-only", "--diff-filter=ACMR", request.base ?? "HEAD"]),
      ...gitPaths(root, ["ls-files", "--others", "--exclude-standard"]),
    ];
  }

  const files: string[] = [];
  for (const path of new Set(candidates)) {
    if (isRegularFile(join(root, path))) files.push(path);
    else if (request.mode === "paths") ignored.push(path);
  }

  return {
    mode: request.mode,
    ...(request.mode === "changed" ? { base: request.base ?? "HEAD" } : {}),
    files: files.sort(),
    partiallyStaged: partiallyStaged.sort(),
    ignored: ignored.sort(),
  };
}

function componentFiles(normalizer: Normalizer, files: string[]): string[] {
  if (normalizer.path === ".") return files;
  const prefix = `${normalizer.path}/`;
  return files.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
}

/** Split an Oxc argument list into its flags (with their values) and its path targets. */
function oxcArguments(tokens: string[]): { flags: string[]; targets: string[] } {
  const flags: string[] = [];
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("-")) {
      targets.push(token);
      continue;
    }
    flags.push(token);
    if (oxcValueFlags.has(token) && index + 1 < tokens.length) flags.push(tokens[(index += 1)]!);
  }
  return { flags, targets };
}

/**
 * Whether a component-relative file is covered by the tool's own path targets. A
 * normalizer must never format or fix a file the repository's own check does not cover.
 */
function coveredByTargets(path: string, targets: string[]): boolean {
  if (!targets.length) return true;
  return targets.some((raw) => {
    const target = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    if (target === "" || target === ".") return true;
    if (/[*?[{]/.test(target)) return matchesGlob(path, target);
    return path === target || path.startsWith(`${target}/`);
  });
}

function packageBinary(root: string, cwd: string, tool: string): string | undefined {
  for (const directory of [cwd, root]) {
    const candidate = join(directory, "node_modules", ".bin", tool);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The tool invocation behind a normalizer, without its path targets. */
function oxcInvocation(
  root: string,
  cwd: string,
  normalizer: Normalizer,
): { executable: string; flags: string[]; targets: string[] } | string {
  const { command, tool } = normalizer;
  if (!packageManagers.has(basename(command[0] ?? ""))) {
    return { executable: command[0]!, ...oxcArguments(command.slice(1)) };
  }
  const runIndex = command.indexOf("run");
  const script = command[runIndex + 1];
  const scripts = readJson<{ scripts?: Record<string, string> }>(
    join(cwd, "package.json"),
  )?.scripts;
  const source = script ? scripts?.[script] : undefined;
  if (!source) return `package script ${script ?? "?"} is not declared`;
  const extra = command.slice(runIndex + 2).filter((token, index) => index > 0 || token !== "--");
  const executable = packageBinary(root, cwd, tool);
  if (!executable) return `${tool} is not installed in node_modules/.bin`;
  return { executable, ...oxcArguments([...source.trim().split(/\s+/).slice(1), ...extra]) };
}

export function scopeNormalizers(
  root: string,
  normalizers: Normalizer[],
  files: string[],
): { scoped: ScopedNormalizer[]; unscopable: UnscopableNormalizer[] } {
  const scoped: ScopedNormalizer[] = [];
  const unscopable: UnscopableNormalizer[] = [];

  for (const normalizer of normalizers) {
    const cwd = normalizer.path === "." ? root : join(root, normalizer.path);
    const extensions =
      normalizer.tool === "oxfmt"
        ? oxfmtExtensions
        : normalizer.tool === "oxlint"
          ? oxlintExtensions
          : normalizer.tool === "dotnet-format"
            ? dotnetExtensions
            : new Set([".rs"]);
    const selected = componentFiles(normalizer, files).filter((path) =>
      extensions.has(extname(path)),
    );
    if (!selected.length) continue;

    let command: string[];
    let covered = selected;
    if (normalizer.tool === "cargo-fmt") {
      // Bare rustfmt on single files ignores each package's edition (and so its style
      // edition) and formats `.rs` files cargo never compiles. Run the repository's own
      // `cargo fmt`, exactly what its `cargo fmt --check` verifies.
      command = [...normalizer.command];
    } else if (normalizer.tool === "dotnet-format") {
      command = [...normalizer.command, "--include", ...selected];
    } else {
      const invocation = oxcInvocation(root, cwd, normalizer);
      if (typeof invocation === "string") {
        unscopable.push({ id: normalizer.id, files: selected, reason: invocation });
        continue;
      }
      covered = selected.filter((path) => coveredByTargets(path, invocation.targets));
      if (!covered.length) continue;
      command = [invocation.executable, ...invocation.flags, ...covered];
    }
    scoped.push({ ...normalizer, command, files: covered });
  }

  return { scoped, unscopable };
}

export function restageNormalizedFiles(root: string, files: string[]): void {
  if (!files.length) return;
  const result = runCommand("git", ["add", "--", ...files], root);
  if (result.error || result.status !== 0) {
    throw new Error(`git add failed: ${result.stderr.trim() || result.error}`);
  }
}
