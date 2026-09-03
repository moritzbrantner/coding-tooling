import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AnalysisDiagnostic,
  AnalysisDiagnosticSeverity,
  AnalysisProvider,
  AnalysisProviderResult,
} from "./analysis-model.ts";
import { relativePosix, runCommand, walkFiles } from "./shared.ts";

const providerId = "typescript-compiler";
const providerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const locatedDiagnosticPattern = /^(.*)\((\d+),(\d+)\):\s+(error|warning|info)\s+TS(\d+):\s*(.*)$/;
const globalDiagnosticPattern = /^(error|warning|info)\s+TS(\d+):\s*(.*)$/;

function severity(value: string): AnalysisDiagnosticSeverity {
  if (value === "error") return "error";
  if (value === "warning") return "warning";
  return "info";
}

function insideRoot(root: string, path: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
}

function diagnosticPath(root: string, configPath: string, path: string): string {
  const normalized = path.trim();
  if (isAbsolute(normalized)) {
    return insideRoot(root, normalized)
      ? relativePosix(root, normalized)
      : normalized.split(sep).join("/");
  }

  const fromProvider = resolve(providerRoot, normalized);
  const fromProject = resolve(dirname(configPath), normalized);
  const absolute = existsSync(fromProvider)
    ? fromProvider
    : existsSync(fromProject)
      ? fromProject
      : fromProvider;
  return insideRoot(root, absolute)
    ? relativePosix(root, absolute)
    : normalized.split(sep).join("/");
}

function compilerCommand(args: string[]) {
  return runCommand(
    "bun",
    ["x", "--no-install", "--package", "typescript", "tsc", ...args],
    providerRoot,
  );
}

function compilerVersion(): { version?: string; reason?: string } {
  const result = compilerCommand(["--version"]);
  if (result.status !== 0) {
    const detail = [result.error, result.stderr.trim(), result.stdout.trim()].find(Boolean);
    return { reason: detail ?? "Pinned TypeScript compiler is unavailable" };
  }
  const value = result.stdout.trim() || result.stderr.trim();
  return { version: value.replace(/^Version\s+/i, "").trim() || undefined };
}

function appendContinuation(diagnostic: AnalysisDiagnostic, line: string): void {
  const continuation = line.trim();
  if (!continuation || /^Found \d+ errors?\.?$/i.test(continuation)) return;
  diagnostic.message = `${diagnostic.message}\n${continuation}`;
}

function parseCompilerDiagnostics(
  root: string,
  configPath: string,
  output: string,
): AnalysisDiagnostic[] {
  const project = relativePosix(root, configPath);
  const diagnostics: AnalysisDiagnostic[] = [];
  let current: AnalysisDiagnostic | undefined;

  for (const line of output.split(/\r?\n/)) {
    const located = line.match(locatedDiagnosticPattern);
    if (located) {
      const [, path, lineNumber, columnNumber, category, code, message] = located;
      current = {
        provider: providerId,
        code: `TS${code}`,
        severity: severity(category),
        message,
        project,
        location: {
          path: diagnosticPath(root, configPath, path),
          startLine: Number(lineNumber),
          startColumn: Number(columnNumber),
        },
      };
      diagnostics.push(current);
      continue;
    }

    const global = line.match(globalDiagnosticPattern);
    if (global) {
      const [, category, code, message] = global;
      current = {
        provider: providerId,
        code: `TS${code}`,
        severity: severity(category),
        message,
        project,
        location: { path: project },
      };
      diagnostics.push(current);
      continue;
    }

    if (current) appendContinuation(current, line);
  }

  return diagnostics;
}

function diagnosticKey(diagnostic: AnalysisDiagnostic): string {
  const location = diagnostic.location;
  return [
    diagnostic.provider,
    diagnostic.project ?? "",
    diagnostic.code,
    diagnostic.severity,
    location?.path ?? "",
    location?.startLine ?? "",
    location?.startColumn ?? "",
    diagnostic.message,
  ].join("\0");
}

function projectDiagnostics(root: string, configPath: string): AnalysisDiagnostic[] {
  const result = compilerCommand(["--project", configPath, "--noEmit", "--pretty", "false"]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const diagnostics = parseCompilerDiagnostics(root, configPath, output);
  if (result.status !== 0 && diagnostics.length === 0) {
    const detail = [result.error, result.stderr.trim(), result.stdout.trim()].find(Boolean);
    throw new Error(detail ?? `TypeScript compiler failed for ${relativePosix(root, configPath)}`);
  }

  const unique = new Map(diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
  return [...unique.values()].sort((left, right) => {
    const leftLocation = left.location;
    const rightLocation = right.location;
    return (
      (leftLocation?.path ?? "").localeCompare(rightLocation?.path ?? "") ||
      (leftLocation?.startLine ?? 0) - (rightLocation?.startLine ?? 0) ||
      (leftLocation?.startColumn ?? 0) - (rightLocation?.startColumn ?? 0) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message)
    );
  });
}

export const typeScriptAnalysisProvider: AnalysisProvider = {
  id: providerId,
  analyze(root: string): AnalysisProviderResult {
    const configs = walkFiles(root, 8)
      .filter((path) => basename(path) === "tsconfig.json")
      .sort();
    if (configs.length === 0) {
      return {
        id: providerId,
        displayName: "TypeScript native compiler",
        status: "not-applicable",
        capabilities: ["syntax", "semantic", "diagnostics"],
        projects: [],
        diagnostics: [],
        reason: "No tsconfig.json project was discovered",
      };
    }

    const compiler = compilerVersion();
    if (!compiler.version) {
      return {
        id: providerId,
        displayName: "TypeScript native compiler",
        status: "unavailable",
        capabilities: ["syntax", "semantic", "diagnostics"],
        projects: configs.map((path) => relativePosix(root, path)),
        diagnostics: [],
        reason: compiler.reason,
      };
    }

    const projects = configs.map((path) => relativePosix(root, path));
    const diagnostics = configs.flatMap((path) => projectDiagnostics(root, path));
    return {
      id: providerId,
      displayName: "TypeScript native compiler",
      version: compiler.version,
      status: "applied",
      capabilities: ["syntax", "semantic", "diagnostics"],
      projects,
      diagnostics,
    };
  },
};
