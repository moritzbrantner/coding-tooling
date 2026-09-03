import type { AnalysisDiagnostic, AnalysisProviderResult } from "./analysis-model.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import type { DetectorContext } from "./expectation-package-context.ts";

type DiagnosticFindingConfig = {
  providerId: string;
  diagnosticCode: string;
  requirementKey: string;
  subjectLabel: string;
  requirementDescription: string;
  singularMessage: (path: string) => string;
  pluralMessage: (path: string, count: number) => string;
};

const typeScriptAssignability: DiagnosticFindingConfig = {
  providerId: "typescript-compiler",
  diagnosticCode: "TS2322",
  requirementKey: "typescript-type-assignability",
  subjectLabel: "TypeScript source",
  requirementDescription: "TypeScript assignments are type-compatible",
  singularMessage: (path) => `TypeScript reports an incompatible assignment in ${path}`,
  pluralMessage: (path, count) => `TypeScript reports ${count} incompatible assignments in ${path}`,
};

const dotNetAssignability: DiagnosticFindingConfig = {
  providerId: "dotnet-roslyn",
  diagnosticCode: "CS0029",
  requirementKey: "dotnet-type-assignability",
  subjectLabel: "C# source",
  requirementDescription: "C# assignments and conversions are type-compatible",
  singularMessage: (path) => `Roslyn reports an incompatible implicit conversion in ${path}`,
  pluralMessage: (path, count) =>
    `Roslyn reports ${count} incompatible implicit conversions in ${path}`,
};

function groupedDiagnostics(
  provider: AnalysisProviderResult,
  diagnosticCode: string,
): Map<string, AnalysisDiagnostic[]> {
  const byFile = new Map<string, AnalysisDiagnostic[]>();
  for (const diagnostic of provider.diagnostics) {
    if (diagnostic.code !== diagnosticCode || !diagnostic.location?.path) continue;
    const current = byFile.get(diagnostic.location.path) ?? [];
    current.push(diagnostic);
    byFile.set(diagnostic.location.path, current);
  }
  return byFile;
}

function providerDiagnosticFindings(
  context: DetectorContext,
  config: DiagnosticFindingConfig,
): RawFinding[] {
  const provider = context.analysisProvider(config.providerId);
  if (!provider || provider.status !== "applied") return [];

  return [...groupedDiagnostics(provider, config.diagnosticCode).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, diagnostics]) => {
      const relatedFiles = new Set<string>([path]);
      for (const diagnostic of diagnostics) {
        if (diagnostic.project) relatedFiles.add(diagnostic.project);
      }
      return {
        subject: {
          kind: "file" as const,
          key: path,
          path,
          description: `${config.subjectLabel} ${path}`,
        },
        requirement: {
          kind: "signal" as const,
          key: config.requirementKey,
          description: config.requirementDescription,
        },
        message:
          diagnostics.length === 1
            ? config.singularMessage(path)
            : config.pluralMessage(path, diagnostics.length),
        evidence: [
          {
            kind: "file" as const,
            path,
            detail: `${diagnostics.length} ${config.diagnosticCode} compiler diagnostic${diagnostics.length === 1 ? "" : "s"}`,
          },
        ],
        analysisEvidence: diagnostics.map((diagnostic) => ({
          provider: diagnostic.provider,
          providerVersion: provider.version,
          code: diagnostic.code,
          message: diagnostic.message,
          project: diagnostic.project,
          location: diagnostic.location,
        })),
        relatedFiles: [...relatedFiles].sort(),
        verification: [["coding-tooling", "analyze", "--json"]],
      };
    });
}

export function typeScriptAssignabilityFindings(context: DetectorContext): RawFinding[] {
  return providerDiagnosticFindings(context, typeScriptAssignability);
}

export function dotNetAssignabilityFindings(context: DetectorContext): RawFinding[] {
  return providerDiagnosticFindings(context, dotNetAssignability);
}
