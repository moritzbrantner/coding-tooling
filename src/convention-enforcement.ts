import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import {
  capabilities,
  type Capability,
  type Component,
  type Diagnostic,
  type ResultStatus,
} from "./model.ts";
import { csharpExplicitControlFlowFailures } from "./csharp-source-shape.ts";
import { rustSourceOrderingOutcome } from "./rust-source-ordering.ts";
import { commandAvailable, findNearestFile, readJson, runCommand, walkFiles } from "./shared.ts";
import { csharpMemberOrderingFailures, reactPropsAdjacencyFailures } from "./source-ordering.ts";

type OxlintEnforcement = {
  kind: "oxlint";
  technologies?: string[];
  config: Record<string, unknown>;
};

type ClippyEnforcement = {
  kind: "clippy";
  technologies?: string[];
  args: string[];
};

type BuiltinEnforcement = {
  kind: "builtin";
  check:
    | "bun-default"
    | "case-portability"
    | "ci-action-pins"
    | "csharp-explicit-control-flow"
    | "csharp-member-order"
    | "env-example"
    | "react-props-adjacency"
    | "rust-source-order"
    | "symlink-boundaries"
    | "text-hygiene"
    | "todo-format"
    | "vitest-kinds";
};

type CapabilityEnforcement = {
  kind: "capability";
  capability: Capability;
  tiers: string[];
};

type ConventionEnforcement = {
  schemaVersion: 1;
  ruleId: string;
  enforcement: OxlintEnforcement | ClippyEnforcement | BuiltinEnforcement | CapabilityEnforcement;
};

export type ConventionCheckResult = {
  ruleId: string;
  kind: string;
  component: string;
  status: ResultStatus;
  command?: string[];
  stdout?: string;
  stderr?: string;
  error?: string;
};

const sourceExtensions = new Set([
  ".cjs",
  ".cs",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".rs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const todoExtensions = new Set([
  ".cjs",
  ".cs",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const knownTextExtensions = new Set([
  ".c",
  ".cjs",
  ".cpp",
  ".cs",
  ".csproj",
  ".css",
  ".editorconfig",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".props",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sln",
  ".sql",
  ".targets",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const knownTextNames = new Set([
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  "Dockerfile",
  "LICENSE",
  "Makefile",
]);
const builtinChecks = new Set([
  "bun-default",
  "case-portability",
  "ci-action-pins",
  "csharp-explicit-control-flow",
  "csharp-member-order",
  "env-example",
  "react-props-adjacency",
  "rust-source-order",
  "symlink-boundaries",
  "text-hygiene",
  "todo-format",
  "vitest-kinds",
]);
const exactBunPackageManager = /^bun@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const exactActionRevision = /^[0-9a-f]{40}$/i;
const ambientEnvironmentKeys = new Set([
  "CI",
  "HOME",
  "NEXT_PHASE",
  "NODE_ENV",
  "PATH",
  "PWD",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "XDG_CACHE_HOME",
]);

function isAmbientEnvironmentKey(key: string): boolean {
  return (
    ambientEnvironmentKeys.has(key) ||
    key.startsWith("ACTIONS_") ||
    key.startsWith("GITHUB_") ||
    key.startsWith("RUNNER_")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTechnologies(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((technology) => typeof technology === "string"))
  );
}

function loadEnforcements(root: string): ConventionEnforcement[] {
  const installRoot = join(root, ".conventions", "modules");
  if (!existsSync(installRoot)) return [];

  const byRule = new Map<string, ConventionEnforcement>();
  for (const path of walkFiles(installRoot, 20).filter((file) => file.endsWith(".json"))) {
    const value = readJson<unknown>(path);
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.ruleId !== "string") continue;
    const enforcement = value.enforcement;
    if (!isRecord(enforcement) || typeof enforcement.kind !== "string") continue;

    if (enforcement.kind === "capability") {
      if (
        typeof enforcement.capability !== "string" ||
        !capabilities.includes(enforcement.capability as Capability) ||
        !Array.isArray(enforcement.tiers) ||
        !enforcement.tiers.every((tier) => typeof tier === "string" && tier.length > 0)
      ) {
        continue;
      }
    } else if (enforcement.kind === "oxlint") {
      if (!isRecord(enforcement.config) || !validTechnologies(enforcement.technologies)) continue;
    } else if (enforcement.kind === "clippy") {
      if (
        !Array.isArray(enforcement.args) ||
        !enforcement.args.every((arg) => typeof arg === "string") ||
        !validTechnologies(enforcement.technologies)
      ) {
        continue;
      }
    } else if (enforcement.kind === "builtin") {
      if (!builtinChecks.has(String(enforcement.check))) continue;
    } else {
      continue;
    }

    byRule.set(value.ruleId, value as unknown as ConventionEnforcement);
  }
  return [...byRule.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

export function conventionRequiredCapabilities(root: string, tier: string): Capability[] {
  return [
    ...new Set(
      loadEnforcements(root).flatMap((item) => {
        const enforcement = item.enforcement;
        return enforcement.kind === "capability" && enforcement.tiers.includes(tier)
          ? [enforcement.capability]
          : [];
      }),
    ),
  ];
}

function appliesTo(component: Component, technologies?: string[]): boolean {
  return (
    !technologies?.length ||
    technologies.every((technology) => component.technologies.includes(technology))
  );
}

function executable(root: string, componentRoot: string, name: string): string | undefined {
  for (const directory of [componentRoot, root]) {
    const unix = join(directory, "node_modules", ".bin", name);
    if (existsSync(unix)) return unix;
    const windows = `${unix}.cmd`;
    if (existsSync(windows)) return windows;
  }
  return commandAvailable(name) ? name : undefined;
}

function resultStatus(status: number, error?: string): ResultStatus {
  return error ? "error" : status === 0 ? "passed" : "failed";
}

function runOxlint(
  root: string,
  component: Component,
  ruleId: string,
  enforcement: OxlintEnforcement,
): ConventionCheckResult {
  const componentRoot = component.path === "." ? root : join(root, component.path);
  const oxlint = executable(root, componentRoot, "oxlint");
  if (!oxlint) {
    return {
      ruleId,
      kind: enforcement.kind,
      component: component.name,
      status: "unavailable",
      error: "oxlint is required to enforce this installed convention",
    };
  }

  const temporary = mkdtempSync(join(tmpdir(), "coding-tooling-oxlint-"));
  const config = join(temporary, "config.json");
  try {
    writeFileSync(config, `${JSON.stringify(enforcement.config, null, 2)}\n`);
    const command = [oxlint, "--config", config, "."];
    const outcome = runCommand(command[0], command.slice(1), componentRoot);
    return {
      ruleId,
      kind: enforcement.kind,
      component: component.name,
      status: resultStatus(outcome.status, outcome.error),
      command,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      error: outcome.error,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runClippy(
  root: string,
  component: Component,
  ruleId: string,
  enforcement: ClippyEnforcement,
): ConventionCheckResult {
  if (!commandAvailable("cargo")) {
    return {
      ruleId,
      kind: enforcement.kind,
      component: component.name,
      status: "unavailable",
      error: "cargo is required to enforce this installed convention",
    };
  }
  const componentRoot = component.path === "." ? root : join(root, component.path);
  const command = ["cargo", ...enforcement.args];
  const outcome = runCommand(command[0], command.slice(1), componentRoot);
  return {
    ruleId,
    kind: enforcement.kind,
    component: component.name,
    status: resultStatus(outcome.status, outcome.error),
    command,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    error: outcome.error,
  };
}

function repositoryFiles(root: string): Array<{ absolutePath: string; relativePath: string }> {
  return walkFiles(root, 20)
    .map((absolutePath) => ({
      absolutePath,
      relativePath: relative(root, absolutePath).replaceAll("\\", "/"),
    }))
    .filter((file) => !file.relativePath.startsWith(".conventions/"));
}

function builtinResult(ruleId: string, check: string, failures: string[]): ConventionCheckResult {
  return {
    ruleId,
    kind: `builtin:${check}`,
    component: "repository",
    status: failures.length ? "failed" : "passed",
    stderr: failures.join("\n"),
  };
}

function bunDefault(root: string, components: Component[], ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  const packages = components.filter((item) => item.kind === "package");
  if (packages.length > 0) {
    const rootManifest = readJson<{ packageManager?: string }>(join(root, "package.json"));
    const rootManager = rootManifest?.packageManager;
    if (!rootManager) {
      failures.push(
        "repository: package.json must declare an exact packageManager such as bun@1.4.0",
      );
    } else if (!exactBunPackageManager.test(rootManager)) {
      failures.push(`repository: packageManager must be an exact Bun version, got ${rootManager}`);
    }
  }

  for (const component of packages) {
    const componentRoot = component.path === "." ? root : join(root, component.path);
    const manifest = readJson<{ packageManager?: string }>(join(componentRoot, "package.json"));
    if (manifest?.packageManager && !exactBunPackageManager.test(manifest.packageManager)) {
      failures.push(
        `${component.name}: packageManager must be an exact Bun version, got ${manifest.packageManager}`,
      );
    }

    const hasBunLock = [componentRoot, root].some(
      (directory) =>
        existsSync(join(directory, "bun.lock")) || existsSync(join(directory, "bun.lockb")),
    );
    if (!hasBunLock) failures.push(`${component.name}: no bun.lock or bun.lockb is present`);

    const conflictingLocks = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter((name) =>
      existsSync(join(componentRoot, name)),
    );
    if (conflictingLocks.length > 0) {
      failures.push(`${component.name}: conflicting lockfile(s): ${conflictingLocks.join(", ")}`);
    }
  }
  return builtinResult(ruleId, "bun-default", failures);
}

function envKeysFromSource(content: string): string[] {
  const expressions = [
    /\b(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bDeno\.env\.get\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
    /\bstd::env::var(?:_os)?\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
    /\bEnvironment\.GetEnvironmentVariable\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
  ];
  const keys = new Set<string>();
  for (const expression of expressions) {
    for (const match of content.matchAll(expression)) keys.add(match[1]);
  }
  return [...keys].filter((key) => !isAmbientEnvironmentKey(key));
}

function envFileKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function envExample(root: string, ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  const tracked = runCommand("git", ["ls-files"], root);
  if (tracked.status === 0) {
    const trackedEnv = tracked.stdout
      .split(/\r?\n/)
      .filter((path) => basename(path) === ".env" || basename(path).startsWith(".env.local"));
    if (trackedEnv.length > 0) {
      failures.push(`tracked local environment file(s): ${trackedEnv.join(", ")}`);
    }
  }

  for (const file of walkFiles(root, 8)) {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    if (relativePath.startsWith(".conventions/") || !sourceExtensions.has(extname(file))) continue;
    try {
      if (statSync(file).size > 1_000_000) continue;
      const keys = envKeysFromSource(readFileSync(file, "utf8"));
      if (keys.length === 0) continue;
      const example = findNearestFile(dirname(file), root, [".env.example"]);
      if (!example) {
        failures.push(`${relativePath}: uses ${keys.join(", ")} but has no .env.example in scope`);
        continue;
      }
      const documented = envFileKeys(example);
      const missing = keys.filter((key) => !documented.has(key));
      if (missing.length > 0) {
        failures.push(
          `${relativePath}: ${relative(root, example)} is missing ${missing.join(", ")}`,
        );
      }
    } catch {
      // Ignore unreadable/non-text source candidates; normal repository checks can diagnose them.
    }
  }

  return builtinResult(ruleId, "env-example", failures);
}

function commentText(line: string): string | undefined {
  const lineComment = line.match(/(?:^|[\s;)}\]])\/\/(.*)$/)?.[1];
  if (lineComment !== undefined) return lineComment;
  const hashComment = line.match(/(?:^|\s)#(.*)$/)?.[1];
  if (hashComment !== undefined) return hashComment;
  const blockStart = line.match(/(?:^|[\s;)}\]])\/\*(.*)$/)?.[1];
  if (blockStart !== undefined) return blockStart;
  return line.match(/^\s*\*(.*)$/)?.[1];
}

function todoFormat(root: string, ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  for (const file of walkFiles(root, 10)) {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    if (relativePath.startsWith(".conventions/") || !todoExtensions.has(extname(file))) continue;
    try {
      if (statSync(file).size > 1_000_000) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const comment = commentText(line);
        if (!comment || (!/\bTODO\b/.test(comment) && !/\bFIXME\b/.test(comment))) continue;
        if (/\bFIXME\b/.test(comment)) {
          failures.push(
            `${relativePath}:${index + 1}: use TODO: ... or TODO(#123): ... instead of FIXME`,
          );
          continue;
        }
        if (!/\bTODO(?:\(#\d+\))?:\s+\S/.test(comment)) {
          failures.push(
            `${relativePath}:${index + 1}: TODO must use TODO: <description> or TODO(#123): <description>`,
          );
        }
      }
    } catch {
      // Ignore unreadable/non-text source candidates; normal repository checks can diagnose them.
    }
  }

  return builtinResult(ruleId, "todo-format", failures);
}

function textHygiene(root: string, ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const file of repositoryFiles(root)) {
    let stats;
    try {
      stats = lstatSync(file.absolutePath);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink() || stats.size > 5_000_000) continue;

    const buffer = readFileSync(file.absolutePath);
    const knownText =
      knownTextExtensions.has(extname(file.absolutePath).toLowerCase()) ||
      knownTextNames.has(basename(file.absolutePath));
    if (buffer.includes(0) && !knownText) continue;

    try {
      decoder.decode(buffer);
    } catch {
      if (knownText) failures.push(`${file.relativePath}: text file is not valid UTF-8`);
      continue;
    }

    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      failures.push(`${file.relativePath}: UTF-8 BOM is not allowed`);
    }
    if (buffer.includes(0x0d)) failures.push(`${file.relativePath}: use LF line endings`);
  }

  return builtinResult(ruleId, "text-hygiene", failures);
}

function ciActionPins(root: string, ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  for (const file of repositoryFiles(root)) {
    const workflowLike =
      (file.relativePath.startsWith(".github/") && /\.ya?ml$/i.test(file.relativePath)) ||
      file.relativePath === "action.yml" ||
      file.relativePath === "action.yaml";
    if (!workflowLike) continue;

    for (const [index, line] of readFileSync(file.absolutePath, "utf8").split(/\r?\n/).entries()) {
      const value = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1];
      if (!value || value.startsWith("./") || value.startsWith("docker://")) continue;
      const separator = value.lastIndexOf("@");
      const revision = separator >= 0 ? value.slice(separator + 1) : "";
      if (!exactActionRevision.test(revision)) {
        failures.push(
          `${file.relativePath}:${index + 1}: external action must use a full commit SHA`,
        );
      }
    }
  }
  return builtinResult(ruleId, "ci-action-pins", failures);
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function symlinkBoundaries(root: string, ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  const absoluteRoot = resolve(root);
  for (const file of repositoryFiles(root)) {
    let stats;
    try {
      stats = lstatSync(file.absolutePath);
    } catch {
      continue;
    }
    if (!stats.isSymbolicLink()) continue;
    const target = resolve(dirname(file.absolutePath), readlinkSync(file.absolutePath));
    if (!withinRoot(absoluteRoot, target)) {
      failures.push(`${file.relativePath}: symlink target escapes repository boundary`);
    }
  }
  return builtinResult(ruleId, "symlink-boundaries", failures);
}

function casePortability(root: string, ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  const seen = new Map<string, string>();
  for (const file of repositoryFiles(root)) {
    const key = file.relativePath.normalize("NFC").toLowerCase();
    const previous = seen.get(key);
    if (previous && previous !== file.relativePath) {
      failures.push(
        `${previous} and ${file.relativePath}: paths collide on case-insensitive filesystems`,
      );
    } else {
      seen.set(key, file.relativePath);
    }
  }
  return builtinResult(ruleId, "case-portability", failures);
}

function vitestKinds(root: string, components: Component[], ruleId: string): ConventionCheckResult {
  const failures: string[] = [];
  for (const component of components.filter((item) => item.kind === "package")) {
    const componentRoot = component.path === "." ? root : join(root, component.path);
    const manifest = readJson<{
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(join(componentRoot, "package.json"));
    const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
    if (!("vitest" in dependencies)) continue;

    let hasUnit = false;
    let hasIntegration = false;
    let hasBenchmark = false;
    const generic: string[] = [];
    for (const file of walkFiles(componentRoot, 8)) {
      const name = basename(file);
      if (/\.unit\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) hasUnit = true;
      else if (/\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) hasIntegration = true;
      else if (/\.bench\.[cm]?[jt]sx?$/.test(name)) hasBenchmark = true;
      else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) {
        generic.push(relative(componentRoot, file));
      }
    }

    if (generic.length > 0) {
      failures.push(`${component.name}: test kind missing in ${generic.join(", ")}`);
    }
    const scripts = manifest?.scripts ?? {};
    if (hasUnit && !("test:unit" in scripts)) {
      failures.push(`${component.name}: missing test:unit script`);
    }
    if (hasIntegration && !("test:integration" in scripts)) {
      failures.push(`${component.name}: missing test:integration script`);
    }
    if (hasBenchmark && !("benchmark" in scripts) && !("bench" in scripts)) {
      failures.push(`${component.name}: missing benchmark or bench script`);
    }
  }

  return builtinResult(ruleId, "vitest-kinds", failures);
}

function runBuiltin(
  root: string,
  components: Component[],
  ruleId: string,
  check: BuiltinEnforcement["check"],
): ConventionCheckResult {
  switch (check) {
    case "bun-default":
      return bunDefault(root, components, ruleId);
    case "case-portability":
      return casePortability(root, ruleId);
    case "ci-action-pins":
      return ciActionPins(root, ruleId);
    case "csharp-explicit-control-flow":
      return builtinResult(
        ruleId,
        "csharp-explicit-control-flow",
        csharpExplicitControlFlowFailures(root, components),
      );
    case "csharp-member-order":
      return builtinResult(
        ruleId,
        "csharp-member-order",
        csharpMemberOrderingFailures(root, components),
      );
    case "env-example":
      return envExample(root, ruleId);
    case "react-props-adjacency":
      return builtinResult(
        ruleId,
        "react-props-adjacency",
        reactPropsAdjacencyFailures(root, components),
      );
    case "rust-source-order": {
      const outcome = rustSourceOrderingOutcome(root, components);
      return {
        ruleId,
        kind: "builtin:rust-source-order",
        component: "repository",
        ...outcome,
      };
    }
    case "symlink-boundaries":
      return symlinkBoundaries(root, ruleId);
    case "text-hygiene":
      return textHygiene(root, ruleId);
    case "todo-format":
      return todoFormat(root, ruleId);
    case "vitest-kinds":
      return vitestKinds(root, components, ruleId);
  }
}

function diagnostic(result: ConventionCheckResult): Diagnostic | undefined {
  if (result.status === "passed") return undefined;
  return {
    code:
      result.status === "unavailable"
        ? "convention-enforcement-unavailable"
        : "convention-enforcement-failed",
    message: `${result.ruleId} ${result.status} for ${result.component}${
      result.error ? `: ${result.error}` : result.stderr ? `: ${result.stderr}` : ""
    }`,
  };
}

export function runConventionChecks(
  root: string,
  components: Component[],
): {
  status: ResultStatus;
  results: ConventionCheckResult[];
  diagnostics: Diagnostic[];
} {
  const results: ConventionCheckResult[] = [];
  for (const item of loadEnforcements(root)) {
    const enforcement = item.enforcement;
    if (enforcement.kind === "capability") continue;

    if (enforcement.kind === "builtin") {
      const result = runBuiltin(root, components, item.ruleId, enforcement.check);
      results.push(result);
      if (result.status !== "passed") break;
      continue;
    }

    let failed = false;
    for (const component of components.filter((candidate) =>
      appliesTo(candidate, enforcement.technologies),
    )) {
      const result =
        enforcement.kind === "oxlint"
          ? runOxlint(root, component, item.ruleId, enforcement)
          : runClippy(root, component, item.ruleId, enforcement);
      results.push(result);
      if (result.status !== "passed") {
        failed = true;
        break;
      }
    }
    if (failed) break;
  }

  const diagnostics = results.map(diagnostic).filter((item): item is Diagnostic => Boolean(item));
  const status: ResultStatus = results.some((item) => item.status === "error")
    ? "error"
    : results.some((item) => item.status === "failed")
      ? "failed"
      : results.some((item) => item.status === "unavailable")
        ? "unavailable"
        : "passed";
  return { status, results, diagnostics };
}
