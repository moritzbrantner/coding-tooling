export const analysisCapabilities = ["syntax", "semantic", "diagnostics", "code-actions"] as const;

export type AnalysisCapability = (typeof analysisCapabilities)[number];
export type AnalysisProviderStatus = "applied" | "not-applicable" | "unavailable" | "failed";
export type AnalysisDiagnosticSeverity = "info" | "warning" | "error";

export type AnalysisLocation = {
  path: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
};

export type AnalysisDiagnostic = {
  provider: string;
  code: string;
  severity: AnalysisDiagnosticSeverity;
  message: string;
  project?: string;
  location?: AnalysisLocation;
};

export type AnalysisProviderResult = {
  id: string;
  displayName: string;
  version?: string;
  status: AnalysisProviderStatus;
  capabilities: AnalysisCapability[];
  projects: string[];
  diagnostics: AnalysisDiagnostic[];
  reason?: string;
};

export type AnalysisProvider = {
  id: string;
  analyze(root: string): AnalysisProviderResult;
};
