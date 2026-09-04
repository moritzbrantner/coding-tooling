import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

import type {
  AnalysisDiagnostic,
  AnalysisDiagnosticSeverity,
  AnalysisProvider,
  AnalysisProviderResult,
} from "./analysis-model.ts";
import { commandAvailable, relativePosix, runCommand, walkFiles } from "./shared.ts";

const providerId = "dotnet-roslyn";
const locatedDiagnosticPattern =
  /^(.*)\((\d+),(\d+)(?:,(\d+),(\d+))?\):\s+(error|warning)\s+([A-Za-z]+\d+):\s*(.*)$/;
const globalDiagnosticPattern = /^(.*?)\s*:\s+(error|warning)\s+([A-Za-z]+\d+):\s*(.*)$/;
const projectSuffixPattern = /^(.*?)\s+\[([^\]]+\.csproj)\]$/;
const unavailablePattern =
  /NETSDK1004|NETSDK1045|project\.assets\.json.*not found|Run a NuGet package restore|specified SDK.*could not be found/i;

function severity(value: string): AnalysisDiagnosticSeverity {
  return value === "error" ? "error" : "warning";
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function insideRoot(root: string, path: string): boolean {
  const absoluteRoot = canonicalPath(root);
  const absolutePath = canonicalPath(path);
  const rootKey = comparablePath(absoluteRoot);
  const pathKey = comparablePath(absolutePath);
  return pathKey === rootKey || pathKey.startsWith(`${rootKey}${sep}`);
}

function normalizedPath(root: string, projectPath: string, sourcePath: string): string {
  const value = sourcePath.trim();
  if (!value || value === "CSC" || value === "MSBUILD") return relativePosix(root, projectPath);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(dirname(projectPath), value);
  if (insideRoot(root, absolute)) {
    return relativePosix(canonicalPath(root), canonicalPath(absolute));
  }
  return value.split(sep).join("/");
}

function stripProjectSuffix(line: string): { text: string; project?: string } {
  const match = line.match(projectSuffixPattern);
  if (!match) return { text: line };
  return { text: match[1]!, project: match[2]! };
}

function appendContinuation(diagnostic: AnalysisDiagnostic, line: string): void {
  const continuation = line.trim();
  if (!continuation || /^Build (?:FAILED|succeeded)\.?$/i.test(continuation)) return;
  if (/^\d+ Warning\(s\)$/.test(continuation) || /^\d+ Error\(s\)$/.test(continuation)) return;
  if (continuation.startsWith("Time Elapsed ")) return;
  diagnostic.message = `${diagnostic.message}\n${continuation}`;
}

function parseBuildDiagnostics(
  root: string,
  projectPath: string,
  output: string,
): AnalysisDiagnostic[] {
  const defaultProject = relativePosix(root, projectPath);
  const diagnostics: AnalysisDiagnostic[] = [];
  let current: AnalysisDiagnostic | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const suffix = stripProjectSuffix(rawLine);
    const project = suffix.project
      ? normalizedPath(root, projectPath, suffix.project)
      : defaultProject;
    const located = suffix.text.match(locatedDiagnosticPattern);
    if (located) {
      const [, sourcePath, startLine, startColumn, endLine, endColumn, category, code, message] =
        located;
      current = {
        provider: providerId,
        code,
        severity: severity(category),
        message,
        project,
        location: {
          path: normalizedPath(root, projectPath, sourcePath),
          startLine: Number(startLine),
          startColumn: Number(startColumn),
          endLine: endLine ? Number(endLine) : undefined,
          endColumn: endColumn ? Number(endColumn) : undefined,
        },
      };
      diagnostics.push(current);
      continue;
    }

    const global = suffix.text.match(globalDiagnosticPattern);
    if (global) {
      const [, source, category, code, message] = global;
      current = {
        provider: providerId,
        code,
        severity: severity(category),
        message,
        project,
        location: { path: normalizedPath(root, projectPath, source) },
      };
      diagnostics.push(current);
      continue;
    }

    if (current && /^\s/.test(rawLine)) appendContinuation(current, rawLine);
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

function sdkVersion(): string | undefined {
  const result = runCommand("dotnet", ["--version"]);
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || result.stderr.trim() || undefined;
}

function projectDiagnostics(
  root: string,
  projectPath: string,
): { diagnostics: AnalysisDiagnostic[]; unavailable?: string; failed?: string } {
  const result = runCommand(
    "dotnet",
    [
      "build",
      projectPath,
      "--no-restore",
      "--nologo",
      "--verbosity:minimal",
      "--property:GenerateFullPaths=true",
      "--property:Deterministic=true",
    ],
    root,
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0 && unavailablePattern.test(output)) {
    return {
      diagnostics: [],
      unavailable: `Roslyn analysis requires a restored project: ${relativePosix(root, projectPath)}`,
    };
  }

  const diagnostics = parseBuildDiagnostics(root, projectPath, output);
  if (result.status !== 0 && diagnostics.length === 0) {
    const detail = [result.error, result.stderr.trim(), result.stdout.trim()].find(Boolean);
    return {
      diagnostics: [],
      failed: detail ?? `dotnet build failed for ${relativePosix(root, projectPath)}`,
    };
  }
  return { diagnostics };
}

export const dotNetRoslynAnalysisProvider: AnalysisProvider = {
  id: providerId,
  analyze(root: string): AnalysisProviderResult {
    const projects = walkFiles(root, 8)
      .filter((path) => basename(path).endsWith(".csproj"))
      .sort();
    if (projects.length === 0) {
      return {
        id: providerId,
        displayName: "Roslyn via .NET SDK",
        status: "not-applicable",
        capabilities: ["semantic", "diagnostics"],
        projects: [],
        diagnostics: [],
        actions: [],
        reason: "No C# project was discovered",
      };
    }

    if (!commandAvailable("dotnet")) {
      return {
        id: providerId,
        displayName: "Roslyn via .NET SDK",
        status: "unavailable",
        capabilities: ["semantic", "diagnostics"],
        projects: projects.map((path) => relativePosix(root, path)),
        diagnostics: [],
        actions: [],
        reason: ".NET SDK is unavailable",
      };
    }

    const version = sdkVersion();
    if (!version) {
      return {
        id: providerId,
        displayName: "Roslyn via .NET SDK",
        status: "unavailable",
        capabilities: ["semantic", "diagnostics"],
        projects: projects.map((path) => relativePosix(root, path)),
        diagnostics: [],
        actions: [],
        reason: ".NET SDK version could not be determined",
      };
    }

    const diagnostics: AnalysisDiagnostic[] = [];
    const unavailable: string[] = [];
    const failed: string[] = [];
    for (const project of projects) {
      const result = projectDiagnostics(root, project);
      diagnostics.push(...result.diagnostics);
      if (result.unavailable) unavailable.push(result.unavailable);
      if (result.failed) failed.push(result.failed);
    }

    const unique = new Map(
      diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]),
    );
    const normalizedDiagnostics = [...unique.values()].sort((left, right) => {
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

    return {
      id: providerId,
      displayName: "Roslyn via .NET SDK",
      version,
      status: failed.length > 0 ? "failed" : unavailable.length > 0 ? "unavailable" : "applied",
      capabilities: ["semantic", "diagnostics"],
      projects: projects.map((path) => relativePosix(root, path)),
      diagnostics: normalizedDiagnostics,
      actions: [],
      reason: failed[0] ?? unavailable[0],
    };
  },
};