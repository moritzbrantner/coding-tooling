import type { AnalysisDiagnostic } from "./analysis-model.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import type { DetectorContext } from "./expectation-package-context.ts";

const providerId = "typescript-compiler";
const diagnosticCode = "TS2322";
const requirementKey = "typescript-type-assignability";

function groupedDiagnostics(diagnostics: AnalysisDiagnostic[]): Map<string, AnalysisDiagnostic[]> {
  const byFile = new Map<string, AnalysisDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== diagnosticCode || !diagnostic.location?.path) continue;
    const current = byFile.get(diagnostic.location.path) ?? [];
    current.push(diagnostic);
    byFile.set(diagnostic.location.path, current);
  }
  return byFile;
}

export function typeScriptAssignabilityFindings(context: DetectorContext): RawFinding[] {
  const provider = context.analysisProvider(providerId);
  if (!provider || provider.status !== "applied") return [];

  return [...groupedDiagnostics(provider.diagnostics).entries()]
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
          description: `TypeScript source ${path}`,
        },
        requirement: {
          kind: "signal" as const,
          key: requirementKey,
          description: "TypeScript assignments are type-compatible",
        },
        message:
          diagnostics.length === 1
            ? `TypeScript reports an incompatible assignment in ${path}`
            : `TypeScript reports ${diagnostics.length} incompatible assignments in ${path}`,
        evidence: [
          {
            kind: "file" as const,
            path,
            detail: `${diagnostics.length} ${diagnosticCode} compiler diagnostic${diagnostics.length === 1 ? "" : "s"}`,
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
