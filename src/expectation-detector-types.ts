import type {
  ExpectationRegistryEntry,
  FindingAnalysisEvidence,
  FindingEvidence,
  FindingRequirement,
  FindingScaffold,
  FindingSubject,
} from "./expectation-model.ts";
import type { DetectorContext } from "./expectation-package-context.ts";

export type EvidenceBasis = "configuration" | "syntax" | "structural" | "semantic";

export type ExpectationEvidenceContract = {
  basis: EvidenceBasis;
  oracle: string;
  independenceKey: string;
  proves: string;
  limitations: string[];
};

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
  evidenceContract: ExpectationEvidenceContract;
  detect: (context: DetectorContext) => RawFinding[];
};

export type ExpectationRegistryRecord = Omit<ExpectationDescriptor, "detect">;
