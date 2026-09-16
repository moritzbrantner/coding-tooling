import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Glob, TOML } from "bun";

import type { Capability } from "./model.ts";
import { type CommandResult, relativePosix, runCommand, walkFiles } from "./shared.ts";
import {
  isTestCapability,
  resolveTestRunner,
  type NativeTestRunner,
  type TestExecutionEvidence,
} from "./test-execution-evidence.ts";

export type TestDiscoveryEvidenceStatus = "available" | "unsupported" | "incomplete";

export type TestDiscoveryEvidence = {
  schemaVersion: 1;
  status: TestDiscoveryEvidenceStatus;
  runner: NativeTestRunner | null;
  strategy: "bun-dry-run" | "vitest-list" | null;
  conventionalCandidateFileCount: number;
  discoveredFileCount: number | null;
  excludedFileCount: number | null;
  conventionalCandidateFiles: string[];
  discoveredFiles: string[] | null;
  excludedFiles: string[] | null;
  truncated: boolean;
  command: string[] | null;
  reason: string;
};

export type TestScopeReconciliation = {
  schemaVersion: 1;
  status: "matched" | "mismatch" | "incomplete";
  discoveredFiles: number | null;
  executedFiles: number | null;
  reason: string;
};

export type TestDiscoveryInput = {
  cwd: string;
  capability: Capability;
  command: string[];
  excludedSubtrees?: readonly string[];
};

type Runner = (command: string, args?: string[], cwd?: string) => CommandResult;

type BunDiscoveryConfig = {
  status: "available" | "incomplete";
  root: string;
  ignorePatterns: string[];
  reason: string;
};

type BunArguments = {
  status: "available" | "incomplete";
  filters: string[];
  ignorePatterns: string[] | null;
  reason: string;
};

const evidenceFileLimit = 50;
const bunTestFilePattern = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/i;
const vitestCandidateFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const bunValueFlags = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--bail",
  "--max-concurrency",
  "--test-name-pattern",
  "-t",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "--preload",
  "--env-file",
]);
const bunBooleanFlags = new Set([
  "--todo",
  "--concurrent",
  "--randomize",
  "--dots",
  "--coverage",
  "--update-snapshots",
  "-u",
  "--smol",
  "--only-failures",
  "--dry-run",
  "--verbose",
]);

function boundedFiles(files: readonly string[]): { values: string[]; truncated: boolean } {
  return {
    values: files.slice(0, evidenceFileLimit),
    truncated: files.length > evidenceFileLimit,
  };
}

function pathInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function normalizeSubtrees(values: readonly string[] = []): string[] {
  return [...new Set(values.map((value) => value.replaceAll("\\", "/").replace(/^\.\//, "")))]
    .filter((value) => value && value !== "." && !value.startsWith("../"))
    .sort();
}

function excludedByComponentBoundary(local: string, subtrees: readonly string[]): boolean {
  return subtrees.some((subtree) => local === subtree || local.startsWith(`${subtree}/`));
}

function hiddenDirectory(local: string): boolean {
  return local
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.startsWith("."));
}

function conventionalCandidates(
  cwd: string,
  runner: NativeTestRunner,
  excludedSubtrees: readonly string[],
): string[] {
  const pattern = runner === "bun" ? bunTestFilePattern : vitestCandidateFilePattern;
  return walkFiles(cwd, 12, { includeIgnoredDirectories: ["fixtures"] })
    .filter((path) => {
      try {
        return lstatSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => relativePosix(cwd, path))
    .filter((local) => !hiddenDirectory(local))
    .filter((local) => !excludedByComponentBoundary(local, excludedSubtrees))
    .filter((local) => pattern.test(local))
    .sort();
}

function incompleteEvidence(
  runner: NativeTestRunner | null,
  candidates: readonly string[],
  reason: string,
  strategy: TestDiscoveryEvidence["strategy"] = null,
  command: string[] | null = null,
): TestDiscoveryEvidence {
  const boundedCandidates = boundedFiles(candidates);
  return {
    schemaVersion: 1,
    status: runner ? "incomplete" : "unsupported",
    runner,
    strategy,
    conventionalCandidateFileCount: candidates.length,
    discoveredFileCount: null,
    excludedFileCount: null,
    conventionalCandidateFiles: boundedCandidates.values,
    discoveredFiles: null,
    excludedFiles: null,
    truncated: boundedCandidates.truncated,
    command,
    reason,
  };
}

function availableEvidence(
  runner: NativeTestRunner,
  strategy: Exclude<TestDiscoveryEvidence["strategy"], null>,
  candidates: readonly string[],
  discovered: readonly string[],
  command: string[],
  reason: string,
): TestDiscoveryEvidence {
  const discoveredSet = new Set(discovered);
  const excluded = candidates.filter((path) => !discoveredSet.has(path));
  const boundedCandidates = boundedFiles(candidates);
  const boundedDiscovered = boundedFiles(discovered);
  const boundedExcluded = boundedFiles(excluded);
  return {
    schemaVersion: 1,
    status: "available",
    runner,
    strategy,
    conventionalCandidateFileCount: candidates.length,
    discoveredFileCount: discovered.length,
    excludedFileCount: excluded.length,
    conventionalCandidateFiles: boundedCandidates.values,
    discoveredFiles: boundedDiscovered.values,
    excludedFiles: boundedExcluded.values,
    truncated:
      boundedCandidates.truncated || boundedDiscovered.truncated || boundedExcluded.truncated,
    command,
    reason,
  };
}

function bunDiscoveryConfig(cwd: string): BunDiscoveryConfig {
  const path = join(cwd, "bunfig.toml");
  if (!existsSync(path)) {
    return { status: "available", root: ".", ignorePatterns: [], reason: "bun-default-config" };
  }

  try {
    const parsed = TOML.parse(readFileSync(path, "utf8")) as { test?: unknown };
    if (parsed.test === undefined) {
      return { status: "available", root: ".", ignorePatterns: [], reason: "bunfig-no-test-table" };
    }
    if (!parsed.test || typeof parsed.test !== "object" || Array.isArray(parsed.test)) {
      return { status: "incomplete", root: ".", ignorePatterns: [], reason: "bunfig-test-invalid" };
    }
    const test = parsed.test as { root?: unknown; pathIgnorePatterns?: unknown };
    const root = test.root === undefined ? "." : test.root;
    if (typeof root !== "string" || !root.trim()) {
      return {
        status: "incomplete",
        root: ".",
        ignorePatterns: [],
        reason: "bunfig-test-root-invalid",
      };
    }
    const ignore = test.pathIgnorePatterns;
    const ignorePatterns =
      ignore === undefined
        ? []
        : typeof ignore === "string"
          ? [ignore]
          : Array.isArray(ignore) && ignore.every((value) => typeof value === "string")
            ? [...ignore]
            : null;
    if (!ignorePatterns) {
      return {
        status: "incomplete",
        root,
        ignorePatterns: [],
        reason: "bunfig-path-ignore-patterns-invalid",
      };
    }
    return { status: "available", root, ignorePatterns, reason: "bunfig-test-config" };
  } catch {
    return { status: "incomplete", root: ".", ignorePatterns: [], reason: "bunfig-unreadable" };
  }
}

function bunArguments(command: readonly string[]): BunArguments {
  if (command[0] !== "bun" || command[1] !== "test") {
    return {
      status: "incomplete",
      filters: [],
      ignorePatterns: null,
      reason: "bun-command-unavailable",
    };
  }

  const filters: string[] = [];
  const ignorePatterns: string[] = [];
  let hasCliIgnorePatterns = false;
  for (let index = 2; index < command.length; index += 1) {
    const value = command[index]!;
    if (value === "--path-ignore-patterns") {
      const next = command[index + 1];
      if (!next || next.startsWith("-")) {
        return {
          status: "incomplete",
          filters,
          ignorePatterns: null,
          reason: "bun-path-ignore-pattern-missing",
        };
      }
      hasCliIgnorePatterns = true;
      ignorePatterns.push(next);
      index += 1;
      continue;
    }
    if (value.startsWith("--path-ignore-patterns=")) {
      hasCliIgnorePatterns = true;
      ignorePatterns.push(value.slice("--path-ignore-patterns=".length));
      continue;
    }
    if (value === "--config" || value.startsWith("--config=")) {
      return {
        status: "incomplete",
        filters,
        ignorePatterns: null,
        reason: "bun-named-config-unsupported",
      };
    }
    if (bunValueFlags.has(value)) {
      if (!command[index + 1]) {
        return {
          status: "incomplete",
          filters,
          ignorePatterns: null,
          reason: "bun-option-value-missing",
        };
      }
      index += 1;
      continue;
    }
    if (bunBooleanFlags.has(value) || value.startsWith("--coverage-reporter=")) continue;
    if (value.startsWith("-")) {
      return {
        status: "incomplete",
        filters,
        ignorePatterns: null,
        reason: "bun-option-unsupported",
      };
    }
    filters.push(value);
  }

  return {
    status: "available",
    filters,
    ignorePatterns: hasCliIgnorePatterns ? ignorePatterns : null,
    reason: "bun-command-scope",
  };
}

function bunFilterMatches(cwd: string, local: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  const absolute = resolve(cwd, local);
  return filters.some((filter) => {
    if (isAbsolute(filter)) return resolve(filter) === absolute;
    if (filter.startsWith("./")) return local === filter.slice(2).replaceAll("\\", "/");
    return local.includes(filter);
  });
}

function globIgnored(local: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Glob(pattern).match(local));
}

function bunDiscovery(
  input: TestDiscoveryInput,
  command: string[],
  candidates: readonly string[],
  runner: Runner,
): TestDiscoveryEvidence {
  const config = bunDiscoveryConfig(input.cwd);
  if (config.status !== "available")
    return incompleteEvidence("bun", candidates, config.reason, "bun-dry-run", null);
  const args = bunArguments(command);
  if (args.status !== "available")
    return incompleteEvidence("bun", candidates, args.reason, "bun-dry-run", null);

  const testRoot = resolve(input.cwd, config.root);
  if (!pathInside(input.cwd, testRoot))
    return incompleteEvidence(
      "bun",
      candidates,
      "bun-test-root-outside-component",
      "bun-dry-run",
      null,
    );

  const ignorePatterns = args.ignorePatterns ?? config.ignorePatterns;
  let discovered: string[];
  try {
    discovered = candidates.filter((local) => {
      const absolute = resolve(input.cwd, local);
      if (!pathInside(testRoot, absolute)) return false;
      if (globIgnored(local, ignorePatterns)) return false;
      return bunFilterMatches(input.cwd, local, args.filters);
    });
  } catch {
    return incompleteEvidence(
      "bun",
      candidates,
      "bun-ignore-pattern-unsupported",
      "bun-dry-run",
      null,
    );
  }

  const dryRunCommand = command.includes("--dry-run") ? [...command] : [...command, "--dry-run"];
  const native = runner(dryRunCommand[0]!, dryRunCommand.slice(1), input.cwd);
  if (native.error || native.status !== 0) {
    return incompleteEvidence(
      "bun",
      candidates,
      native.error ? "bun-dry-run-unavailable" : "bun-dry-run-failed",
      "bun-dry-run",
      dryRunCommand,
    );
  }

  return availableEvidence(
    "bun",
    "bun-dry-run",
    candidates,
    discovered,
    dryRunCommand,
    "bun-native-config-and-documented-file-selection",
  );
}

function vitestListCommand(command: readonly string[]): string[] | null {
  const vitestIndex = command[0] === "vitest" ? 0 : command[1] === "vitest" ? 1 : -1;
  if (vitestIndex < 0) return null;
  const prefix = command.slice(0, vitestIndex + 1);
  let rest = command.slice(vitestIndex + 1);
  const subcommand = rest[0];
  if (subcommand === "run") rest = rest.slice(1);
  else if (["watch", "dev", "related", "bench", "init", "doctor"].includes(subcommand ?? ""))
    return null;
  rest = rest.filter(
    (value) => value !== "--run" && value !== "--watch" && value !== "--filesOnly",
  );
  return [...prefix, "list", ...rest, "--filesOnly"];
}

function vitestDiscoveredFiles(
  cwd: string,
  stdout: string,
  excludedSubtrees: readonly string[],
): { status: "available"; files: string[] } | { status: "incomplete"; reason: string } {
  const files: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const value = raw.replace(ansiEscapePattern, "").trim();
    if (!value) continue;
    const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
    if (!pathInside(cwd, absolute))
      return { status: "incomplete", reason: "vitest-discovery-outside-component" };
    const local = relativePosix(cwd, absolute);
    if (excludedByComponentBoundary(local, excludedSubtrees)) {
      return { status: "incomplete", reason: "vitest-discovery-cross-component" };
    }
    if (!existsSync(absolute))
      return { status: "incomplete", reason: "vitest-discovery-path-unreadable" };
    files.push(local);
  }
  return { status: "available", files: [...new Set(files)].sort() };
}

function vitestDiscovery(
  input: TestDiscoveryInput,
  command: string[],
  candidates: readonly string[],
  excludedSubtrees: readonly string[],
  runner: Runner,
): TestDiscoveryEvidence {
  const listCommand = vitestListCommand(command);
  if (!listCommand)
    return incompleteEvidence(
      "vitest",
      candidates,
      "vitest-list-command-unsupported",
      "vitest-list",
      null,
    );
  const native = runner(listCommand[0]!, listCommand.slice(1), input.cwd);
  if (native.error || native.status !== 0) {
    return incompleteEvidence(
      "vitest",
      candidates,
      native.error ? "vitest-list-unavailable" : "vitest-list-failed",
      "vitest-list",
      listCommand,
    );
  }
  const parsed = vitestDiscoveredFiles(input.cwd, native.stdout, excludedSubtrees);
  if (parsed.status !== "available")
    return incompleteEvidence("vitest", candidates, parsed.reason, "vitest-list", listCommand);
  return availableEvidence(
    "vitest",
    "vitest-list",
    candidates,
    parsed.files,
    listCommand,
    "vitest-native-file-list",
  );
}

export function collectTestDiscoveryEvidence(
  input: TestDiscoveryInput,
  runner: Runner = runCommand,
): TestDiscoveryEvidence | undefined {
  if (!isTestCapability(input.capability)) return undefined;
  const resolution = resolveTestRunner(input.cwd, input.command);
  if (!resolution.runner) return incompleteEvidence(null, [], resolution.reason);
  const excludedSubtrees = normalizeSubtrees(input.excludedSubtrees);
  const candidates = conventionalCandidates(input.cwd, resolution.runner, excludedSubtrees);
  if (!resolution.command) {
    return incompleteEvidence(
      resolution.runner,
      candidates,
      "native-runner-command-not-safely-resolved",
    );
  }
  return resolution.runner === "bun"
    ? bunDiscovery(input, resolution.command, candidates, runner)
    : vitestDiscovery(input, resolution.command, candidates, excludedSubtrees, runner);
}

export function reconcileTestScope(
  discovery: TestDiscoveryEvidence | undefined,
  execution: TestExecutionEvidence | undefined,
): TestScopeReconciliation | undefined {
  if (!discovery && !execution) return undefined;
  if (!discovery || !execution) {
    return {
      schemaVersion: 1,
      status: "incomplete",
      discoveredFiles: discovery?.discoveredFileCount ?? null,
      executedFiles: execution?.executedFiles ?? null,
      reason: discovery ? "execution-evidence-unavailable" : "discovery-evidence-unavailable",
    };
  }
  if (discovery.reason === "vitest-discovery-cross-component") {
    return {
      schemaVersion: 1,
      status: "mismatch",
      discoveredFiles: discovery.discoveredFileCount,
      executedFiles: execution.executedFiles,
      reason: "native-discovery-cross-component",
    };
  }
  if (discovery.status !== "available") {
    return {
      schemaVersion: 1,
      status: "incomplete",
      discoveredFiles: discovery.discoveredFileCount,
      executedFiles: execution.executedFiles,
      reason: `discovery-${discovery.status}`,
    };
  }
  if (execution.status !== "available") {
    return {
      schemaVersion: 1,
      status: "incomplete",
      discoveredFiles: discovery.discoveredFileCount,
      executedFiles: execution.executedFiles,
      reason: `execution-${execution.status}`,
    };
  }
  if (discovery.runner !== execution.runner) {
    return {
      schemaVersion: 1,
      status: "mismatch",
      discoveredFiles: discovery.discoveredFileCount,
      executedFiles: execution.executedFiles,
      reason: "runner-mismatch",
    };
  }
  if (discovery.discoveredFileCount === null || execution.executedFiles === null) {
    return {
      schemaVersion: 1,
      status: "incomplete",
      discoveredFiles: discovery.discoveredFileCount,
      executedFiles: execution.executedFiles,
      reason: "file-count-unavailable",
    };
  }
  return discovery.discoveredFileCount === execution.executedFiles
    ? {
        schemaVersion: 1,
        status: "matched",
        discoveredFiles: discovery.discoveredFileCount,
        executedFiles: execution.executedFiles,
        reason: "native-discovery-matches-execution",
      }
    : {
        schemaVersion: 1,
        status: "mismatch",
        discoveredFiles: discovery.discoveredFileCount,
        executedFiles: execution.executedFiles,
        reason: "native-discovery-execution-file-count-mismatch",
      };
}
