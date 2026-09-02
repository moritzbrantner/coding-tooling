import type {
  ExpectationCoverageStatus,
  ExpectationRegistryEntry,
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
  relatedFiles: string[];
  verification: string[][];
  scaffold?: FindingScaffold;
};

export type DetectorApplicability = {
  status: ExpectationCoverageStatus;
  subjects: number;
};

export type ExpectationDescriptor = ExpectationRegistryEntry & {
  detect: (context: DetectorContext) => RawFinding[];
  coverage: (context: DetectorContext) => DetectorApplicability;
};
