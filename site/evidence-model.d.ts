export const NORMALIZED_EVIDENCE_SCHEMA_VERSION: 1;

export type EvidenceCollector = "filesystem" | "github";
export type EvidenceAvailability = "available" | "incomplete";
export type EvidenceProvenance = {
  collector: EvidenceCollector;
  path: string;
};

export type PackageEvidenceV1 = {
  schemaVersion: 1;
  component: {
    name: string;
    path: string;
    kind: "package";
  };
  facts: {
    manifest: {
      status: EvidenceAvailability;
      path: string;
      provenance: EvidenceProvenance;
    };
    scripts: {
      status: EvidenceAvailability;
      value: Record<string, string>;
      provenance: EvidenceProvenance;
    };
    dependencies: {
      status: EvidenceAvailability;
      value: Record<string, string>;
      provenance: EvidenceProvenance;
    };
    devDependencies: {
      status: EvidenceAvailability;
      value: Record<string, string>;
      provenance: EvidenceProvenance;
    };
    packageManager: {
      status: EvidenceAvailability;
      value: string | null;
      provenance: EvidenceProvenance;
    };
    tsconfig: {
      status: EvidenceAvailability;
      value: boolean;
      provenance: EvidenceProvenance;
    };
    lockfiles: {
      status: EvidenceAvailability;
      value: string[];
      provenance: EvidenceProvenance[];
    };
  };
};

export type PackageEvidenceInput = {
  collector: EvidenceCollector;
  name: string;
  path: string;
  manifestPath: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  hasTsconfig?: boolean;
  tsconfigPath?: string;
  lockfiles?: string[];
};

export type PackageSemantics = {
  technologies: string[];
  declaredCapabilities: Record<string, string>;
};

export type PackageCapabilityOutcome = {
  capability: string;
  status: "satisfied" | "finding" | "incomplete";
  script?: string;
  provenance: EvidenceProvenance[];
};

export const PACKAGE_SCRIPT_CANDIDATES: Readonly<Record<string, readonly string[]>>;

export function createPackageEvidence(input: PackageEvidenceInput): PackageEvidenceV1;
export function packageSemantics(evidence: PackageEvidenceV1): PackageSemantics;
export function canonicalPackageCapabilityOutcomes(
  evidence: PackageEvidenceV1,
  required?: string[],
): PackageCapabilityOutcome[];
