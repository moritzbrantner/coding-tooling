import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { applyConventionConfigurations } from "./convention-config.ts";
import { discoverComponents, loadConfig } from "./core.ts";
import type { Capability, Component, ResultEnvelope, ResultStatus } from "./model.ts";
import {
  readJson,
  relativePosix,
  runCommand,
  walkFiles,
  type CommandResult,
} from "./shared.ts";

type NormalizationCapability = Extract<Capability, "format:check" | "lint">;
type NormalizationTool = "cargo-fmt" | "dotnet-format" | "oxfmt" | "oxlint";

type PackageManifest = {
  scripts?: Record<string, string>;
};

export type Normalizer = {
  id: string;
  component: string;
  path: string;
  capability: NormalizationCapability;
  tool: NormalizationTool;
  command: string[];
};

export type UnsupportedNormalizer = {
  component: string;
  path: string;
  capability: NormalizationCapability;
  command: string[];
  reason: string;
};

export type NormalizationPass = {
  pass: number;
  status: ResultStatus;
  results: Array<
    Normalizer & {
      status: ResultStatus;
      exitCode: number;
      durationMs: number;
      stdout: string;
      stderr: string;
      error?: string;
    }
  >;
};

export type NormalizationPlan = {
  normalizers: Normalizer[];
  unsupported: UnsupportedNormalizer[];
};

export type NormalizationDependencies = {
  execute?: (root: string, normalizer: Normalizer) => CommandResult;
  fingerprint?: (root: string) => string;
};

const mutationCapabilities: NormalizationCapability[] = ["lint", "format:check"];
const packageManagers = new Set(["bun", "npm", "pnpm", "yarn"]);
const shellSyntax = /[;&|`$><\n\r]/;

function effectiveComponents(root: string): Component[] {
  const config = loadConfig(root);
  const configured = discoverComponents(root).map((component) => ({
    ...component,
    capabilities: {
      ...component.capabilities,
      ...config.capabilityCommands?.[component.name],
      ...config.capabilityCommands?.[component.path],
    },
  }));
  return applyConventionConfigurations(root, configured);
}

function packageManifest(root: string, component: Component): PackageManifest {
  const directory = component.path === "." ? root : join(root, component.path);
  return readJson<PackageManifest>(join(directory, "package.json")) ?? {};
}

function safeToolScript(source: string, tool: "oxfmt" | "oxlint"): string[] | undefined {
  const trimmed = source.trim();
  if (!trimmed || shellSyntax.test(trimmed) || /["'\\]/.test(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== tool) return undefined;
  return tokens;
}

function safeOxfmtWriteScript(source: string): boolean {
  const tokens = safeToolScript(source, "oxfmt");
  return tokens !== undefined && !tokens.includes("--check");
}

function safeOxlintFixScript(source: string): boolean {
  const tokens = safeToolScript(source, "oxlint");
  if (!tokens || !tokens.includes("--fix")) return false;
  return !tokens.some((token) => token.startsWith("--fix-") && token !== "--fix");
}

function packageScriptInvocation(command: string[]): { scriptIndex: number; script: string } | undefined {
  if (!packageManagers.has(basename(command[0] ?? ""))) return undefined;
  const runIndex = command.indexOf("run");
  if (runIndex < 0) return undefined;
  const scriptIndex = runIndex + 1;
  const script = command[scriptIndex];
  return script && !script.startsWith("-") ? { scriptIndex, script } : undefined;
}

function packageNormalizer(
  root: string,
  component: Component,
  capability: NormalizationCapability,
  command: string[],
): Normalizer | undefined {
  if (component.kind !== "package") return undefined;
  const invocation = packageScriptInvocation(command);
  if (!invocation) return undefined;
  const scripts = packageManifest(root, component).scripts ?? {};
  const candidates =
    capability === "format:check"
      ? ["format:write", "format:fix", "format"]
      : ["lint:fix", "lint:write"];
  const selected = candidates.find((name) => {
    const source = scripts[name];
    if (typeof source !== "string") return false;
    return capability === "format:check"
      ? safeOxfmtWriteScript(source)
      : safeOxlintFixScript(source);
  });
  if (!selected) return undefined;
  const mutation = [...command];
  mutation[invocation.scriptIndex] = selected;
  const tool: NormalizationTool = capability === "format:check" ? "oxfmt" : "oxlint";
  return {
    id: `${component.path}:${capability}:${tool}`,
    component: component.name,
    path: component.path,
    capability,
    tool,
    command: mutation,
  };
}

function without(command: string[], value: string): string[] {
  return command.filter((part) => part !== value);
}

function directNormalizer(
  component: Component,
  capability: NormalizationCapability,
  command: string[],
): Normalizer | undefined {
  const executable = basename(command[0] ?? "");
  let tool: NormalizationTool | undefined;
  let mutation: string[] | undefined;

  if (capability === "format:check" && executable === "oxfmt" && command.includes("--check")) {
    tool = "oxfmt";
    mutation = without(command, "--check");
  } else if (
    capability === "format:check" &&
    executable === "cargo" &&
    command[1] === "fmt" &&
    command.includes("--check")
  ) {
    tool = "cargo-fmt";
    mutation = without(command, "--check");
  } else if (
    capability === "format:check" &&
    executable === "dotnet" &&
    command[1] === "format" &&
    command.includes("--verify-no-changes")
  ) {
    tool = "dotnet-format";
    mutation = without(command, "--verify-no-changes");
  } else if (capability === "lint" && executable === "oxlint") {
    if (command.some((part) => part.startsWith("--fix-") && part !== "--fix")) return undefined;
    tool = "oxlint";
    mutation = command.includes("--fix")
      ? [...command]
      : [command[0]!, "--fix", ...command.slice(1)];
  }

  if (!tool || !mutation) return undefined;
  return {
    id: `${component.path}:${capability}:${tool}`,
    component: component.name,
    path: component.path,
    capability,
    tool,
    command: mutation,
  };
}

function normalizerFor(
  root: string,
  component: Component,
  capability: NormalizationCapability,
  command: string[],
): Normalizer | undefined {
  return packageNormalizer(root, component, capability, command) ?? directNormalizer(component, capability, command);
}

export function planNormalization(root: string): NormalizationPlan {
  const normalizers: Normalizer[] = [];
  const unsupported: UnsupportedNormalizer[] = [];

  for (const component of effectiveComponents(root)) {
    for (const capability of mutationCapabilities) {
      const command = component.capabilities[capability];
      if (!command) continue;
      const normalizer = normalizerFor(root, component, capability, command);
      if (normalizer) normalizers.push(normalizer);
      else {
        unsupported.push({
          component: component.name,
          path: component.path,
          capability,
          command: [...command],
          reason: "No closed deterministic mutation adapter is available for this check command",
        });
      }
    }
  }

  const unique = new Map<string, Normalizer>();
  for (const normalizer of normalizers) {
    const key = `${normalizer.path}\0${normalizer.capability}\0${JSON.stringify(normalizer.command)}`;
    unique.set(key, normalizer);
  }

  return {
    normalizers: [...unique.values()].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        mutationCapabilities.indexOf(left.capability) - mutationCapabilities.indexOf(right.capability) ||
        left.id.localeCompare(right.id),
    ),
    unsupported: unsupported.sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.capability.localeCompare(right.capability),
    ),
  };
}

export function repositoryContentFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const path of walkFiles(root, 16).sort()) {
    const local = relativePosix(root, path);
    try {
      const stat = lstatSync(path);
      hash.update(local).update("\0");
      if (stat.isSymbolicLink()) {
        hash.update("symlink\0").update(readlinkSync(path)).update("\0");
      } else if (stat.isFile()) {
        hash.update("file\0").update(readFileSync(path)).update("\0");
      }
    } catch {
      hash.update("unreadable\0");
    }
  }
  return hash.digest("hex");
}

function defaultExecute(root: string, normalizer: Normalizer): CommandResult {
  const cwd = normalizer.path === "." ? root : join(root, normalizer.path);
  return runCommand(normalizer.command[0]!, normalizer.command.slice(1), cwd);
}

function runPass(
  root: string,
  pass: number,
  normalizers: Normalizer[],
  execute: (root: string, normalizer: Normalizer) => CommandResult,
): NormalizationPass {
  const results: NormalizationPass["results"] = [];
  for (const normalizer of normalizers) {
    const started = Date.now();
    const executed = execute(root, normalizer);
    const status: ResultStatus = executed.error
      ? "error"
      : executed.status === 0
        ? "passed"
        : "failed";
    results.push({
      ...normalizer,
      status,
      exitCode: executed.status,
      durationMs: Date.now() - started,
      stdout: executed.stdout,
      stderr: executed.stderr,
      error: executed.error,
    });
    if (status !== "passed") break;
  }
  const status: ResultStatus = results.some((result) => result.status === "error")
    ? "error"
    : results.some((result) => result.status === "failed")
      ? "failed"
      : "passed";
  return { pass, status, results };
}

export function normalizeRepository(
  root: string,
  dependencies: NormalizationDependencies = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  try {
    const plan = planNormalization(root);
    const execute = dependencies.execute ?? defaultExecute;
    const fingerprint = dependencies.fingerprint ?? repositoryContentFingerprint;
    const coverage =
      plan.normalizers.length === 0
        ? plan.unsupported.length === 0
          ? "not-applicable"
          : "unsupported"
        : plan.unsupported.length === 0
          ? "complete"
          : "partial";

    if (plan.normalizers.length === 0) {
      return {
        schemaVersion: 1,
        operation: "normalize",
        status: "passed",
        durationMs: Date.now() - started,
        data: {
          root,
          result: "no-op",
          coverage,
          changed: false,
          idempotent: true,
          normalizers: [],
          unsupported: plan.unsupported,
          passes: [],
        },
        diagnostics: [],
      };
    }

    const beforeFingerprint = fingerprint(root);
    const first = runPass(root, 1, plan.normalizers, execute);
    if (first.status !== "passed") {
      return {
        schemaVersion: 1,
        operation: "normalize",
        status: first.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          coverage,
          changed: false,
          idempotent: false,
          normalizers: plan.normalizers,
          unsupported: plan.unsupported,
          passes: [first],
          beforeFingerprint,
        },
        diagnostics: [
          {
            code: "normalization-command-failed",
            message: "A deterministic normalization command failed",
          },
        ],
      };
    }

    const normalizedFingerprint = fingerprint(root);
    const second = runPass(root, 2, plan.normalizers, execute);
    if (second.status !== "passed") {
      return {
        schemaVersion: 1,
        operation: "normalize",
        status: second.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          coverage,
          changed: beforeFingerprint !== normalizedFingerprint,
          idempotent: false,
          normalizers: plan.normalizers,
          unsupported: plan.unsupported,
          passes: [first, second],
          beforeFingerprint,
          normalizedFingerprint,
        },
        diagnostics: [
          {
            code: "normalization-command-failed",
            message: "A deterministic normalization command failed on the verification pass",
          },
        ],
      };
    }

    const verificationFingerprint = fingerprint(root);
    if (normalizedFingerprint !== verificationFingerprint) {
      return {
        schemaVersion: 1,
        operation: "normalize",
        status: "failed",
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          coverage,
          changed: beforeFingerprint !== normalizedFingerprint,
          idempotent: false,
          normalizers: plan.normalizers,
          unsupported: plan.unsupported,
          passes: [first, second],
          beforeFingerprint,
          normalizedFingerprint,
          verificationFingerprint,
        },
        diagnostics: [
          {
            code: "normalization-not-idempotent",
            message: "The second normalization pass changed repository content again",
          },
        ],
      };
    }

    return {
      schemaVersion: 1,
      operation: "normalize",
      status: "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        result: beforeFingerprint === normalizedFingerprint ? "no-op" : "normalized",
        coverage,
        changed: beforeFingerprint !== normalizedFingerprint,
        idempotent: true,
        normalizers: plan.normalizers,
        unsupported: plan.unsupported,
        passes: [first, second],
        beforeFingerprint,
        normalizedFingerprint,
        verificationFingerprint,
        policy: {
          closedAdaptersOnly: true,
          deterministicOrder: "component-path-then-lint-then-format",
          secondPassMustBeNoOp: true,
          unsupportedChecksRemainValidationOwned: true,
        },
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "normalize",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, result: "blocked" },
      diagnostics: [
        {
          code: "normalization-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
