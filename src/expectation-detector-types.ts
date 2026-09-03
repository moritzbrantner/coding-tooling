import type {
  ExpectationRegistryEntry,
  FindingAnalysisEvidence,
  FindingEvidence,
  FindingRequirement,
  FindingScaffold,
  FindingSubject,
} from "./expectation-model.ts";
import type { DetectorContext } from "./expectation-package-context.ts";

export type RawFinding = {
  subject: FindingSubject;
  requirement: FindingRequirement;
  message: string;
  evidence: FindingEvidence[];
  analysisEvidence?: FindingAnalysisEvidence[];
  relatedFiles: string[];
  verification: string[][];
  scaffold?: FindingScaffold;
};

export type ExpectationDescriptor = ExpectationRegistryEntry & {
  detect: (context: DetectorContext) => RawFinding[];
};
