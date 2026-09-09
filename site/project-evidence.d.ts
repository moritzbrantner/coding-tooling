import type { EvidenceCollector, EvidenceProvenance } from "./evidence-model.js";

export type ProjectEvidenceKind = "rust" | "dotnet";

export type ProjectManifestEvidenceV1 = {
  schemaVersion: 1;
  component: {
    name: string;
    path: string;
    kind: ProjectEvidenceKind;
  };
  facts: {
    manifests: {
      status: "available" | "incomplete";
      value: string[];
      provenance: EvidenceProvenance[];
    };
  };
};

export type ProjectManifestEvidenceInput = {
  collector: EvidenceCollector;
  name: string;
  path: string;
  kind: ProjectEvidenceKind;
  manifestPaths?: string[];
};

export type ProjectManifestSemantics = {
  kind: ProjectEvidenceKind;
  manifestStatus: "available" | "incomplete";
  manifestPaths: string[];
};

export type ProjectComponentReference = {
  name: string;
  path: string;
  kind: ProjectEvidenceKind | string;
};

export type GithubProjectSnapshot = {
  tree?: Array<{ path?: string | null }>;
};

export function createProjectManifestEvidence(
  input: ProjectManifestEvidenceInput,
): ProjectManifestEvidenceV1;
export function collectGithubProjectManifestEvidence(
  snapshot: GithubProjectSnapshot,
  components: ProjectComponentReference[],
): ProjectManifestEvidenceV1[];
export function projectManifestSemantics(
  evidence: ProjectManifestEvidenceV1,
): ProjectManifestSemantics;
