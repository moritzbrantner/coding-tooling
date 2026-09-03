import { basename, dirname, resolve, sep } from "node:path";

import * as ts from "typescript";

import type {
  AnalysisDiagnostic,
  AnalysisDiagnosticSeverity,
  AnalysisProvider,
  AnalysisProviderResult,
} from "./analysis-model.ts";
import { relativePosix, walkFiles } from "./shared.ts";

const providerId = "typescript-compiler";

function severity(category: ts.DiagnosticCategory): AnalysisDiagnosticSeverity {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  return "info";
}

function diagnosticPath(root: string, fileName: string): string {
  const absoluteRoot = resolve(root);
  const absoluteFile = resolve(fileName);
  if (absoluteFile === absoluteRoot || absoluteFile.startsWith(`${absoluteRoot}${sep}`)) {
    return relativePosix(absoluteRoot, absoluteFile);
  }
  return fileName.split(sep).join("/");
}

function normalizeDiagnostic(
  root: string,
  project: string,
  diagnostic: ts.Diagnostic,
): AnalysisDiagnostic {
  const result: AnalysisDiagnostic = {
    provider: providerId,
    code: `TS${diagnostic.code}`,
    severity: severity(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    project,
  };

  if (!diagnostic.file) {
    result.location = { path: project };
    return result;
  }

  const location = {
    path: diagnosticPath(root, diagnostic.file.fileName),
  } as NonNullable<AnalysisDiagnostic["location"]>;
  if (diagnostic.start !== undefined) {
    const start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    location.startLine = start.line + 1;
    location.startColumn = start.character + 1;
    if (diagnostic.length !== undefined) {
      const end = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length);
      location.endLine = end.line + 1;
      location.endColumn = end.character + 1;
    }
  }
  result.location = location;
  return result;
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
  const project = relativePosix(root, configPath);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return [normalizeDiagnostic(root, project, read.error)];

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    { noEmit: true },
    configPath,
  );
  const diagnostics: ts.Diagnostic[] = [...parsed.errors];

  if (parsed.fileNames.length > 0) {
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
      projectReferences: parsed.projectReferences,
    });
    diagnostics.push(...ts.getPreEmitDiagnostics(program));
  }

  const normalized = diagnostics.map((diagnostic) => normalizeDiagnostic(root, project, diagnostic));
  const unique = new Map(normalized.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
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
        displayName: "TypeScript Compiler API",
        version: ts.version,
        status: "not-applicable",
        capabilities: ["syntax", "semantic", "diagnostics"],
        projects: [],
        diagnostics: [],
        reason: "No tsconfig.json project was discovered",
      };
    }

    const projects = configs.map((path) => relativePosix(root, path));
    const diagnostics = configs.flatMap((path) => projectDiagnostics(root, path));
    return {
      id: providerId,
      displayName: "TypeScript Compiler API",
      version: ts.version,
      status: "applied",
      capabilities: ["syntax", "semantic", "diagnostics"],
      projects,
      diagnostics,
    };
  },
};
