import { performance } from "node:perf_hooks";

import type {
  AnalysisDiagnostic,
  AnalysisProvider,
  AnalysisProviderResult,
} from "./analysis-model.ts";
import { typeScriptAnalysisProvider } from "./analysis-typescript.ts";
import type { ResultEnvelope } from "./model.ts";

export type AnalysisData = {
  providers: AnalysisProviderResult[];
  diagnostics: AnalysisDiagnostic[];
};

const providers: AnalysisProvider[] = [typeScriptAnalysisProvider];

function failedProvider(provider: AnalysisProvider, error: unknown): AnalysisProviderResult {
  return {
    id: provider.id,
    displayName: provider.id,
    status: "failed",
    capabilities: [],
    projects: [],
    diagnostics: [],
    reason: error instanceof Error ? error.message : String(error),
  };
}

export function analyzeRepository(root: string): ResultEnvelope<AnalysisData> {
  const started = performance.now();
  const results = providers.map((provider) => {
    try {
      return provider.analyze(root);
    } catch (error) {
      return failedProvider(provider, error);
    }
  });
  const diagnostics = results
    .flatMap((provider) => provider.diagnostics)
    .sort((left, right) => {
      const leftLocation = left.location;
      const rightLocation = right.location;
      return (
        left.provider.localeCompare(right.provider) ||
        (leftLocation?.path ?? "").localeCompare(rightLocation?.path ?? "") ||
        (leftLocation?.startLine ?? 0) - (rightLocation?.startLine ?? 0) ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message)
      );
    });
  const providerFailures = results.filter((provider) => provider.status === "failed");
  const providerUnavailable = results.filter((provider) => provider.status === "unavailable");
  const appliedProviders = results.filter((provider) => provider.status === "applied");
  const status =
    providerFailures.length > 0
      ? "error"
      : diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "failed"
        : providerUnavailable.length > 0 && appliedProviders.length === 0
          ? "unavailable"
          : "passed";

  return {
    schemaVersion: 1,
    operation: "analyze",
    status,
    durationMs: Math.round(performance.now() - started),
    data: { providers: results, diagnostics },
    diagnostics: [
      ...providerFailures.map((provider) => ({
        code: "analysis-provider-failed",
        message: `${provider.id}: ${provider.reason ?? "analysis provider failed"}`,
      })),
      ...providerUnavailable.map((provider) => ({
        code: "analysis-provider-unavailable",
        message: `${provider.id}: ${provider.reason ?? "analysis provider unavailable"}`,
      })),
    ],
  };
}
