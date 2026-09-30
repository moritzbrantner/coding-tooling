import type { EvidenceCollector, EvidenceProvenance } from "./evidence-model.js";
import type { ProjectComponentReference, ProjectEvidenceKind } from "./project-evidence.js";

export type ProjectToolchainEvidenceV1 = {
  schemaVersion: 1;
  component: { name: string; path: string; kind: ProjectEvidenceKind };
  facts: {
    declarations: {
      status: "available" | "incomplete";
      value: Array<{ path: string; content: string | null }>;
      provenance: EvidenceProvenance[];
    };
  };
};
export type ProjectToolchainEvidenceInput = {
  collector: EvidenceCollector;
  name: string;
  path: string;
  kind: ProjectEvidenceKind;
  files: Record<string, string | null>;
  complete?: boolean;
};
export type ProjectToolchainOutcome = {
  runtime: ProjectEvidenceKind;
  status: "satisfied" | "finding" | "unsupported" | "incomplete";
  reason: string;
  provenance: EvidenceProvenance[];
  declaration?: string;
  inheritedFrom?: string;
  version?: string;
  rollForward?: string;
};
export function projectToolchainPaths(path: string, kind: ProjectEvidenceKind): string[];
export function createProjectToolchainEvidence(
  input: ProjectToolchainEvidenceInput,
): ProjectToolchainEvidenceV1;
export function collectGithubProjectToolchainEvidence(
  snapshot: {
    tree?: Array<{ path?: string | null; type?: string | null; mode?: string | null }>;
    files?: Record<string, string>;
    treeTruncated?: boolean;
  },
  components: ProjectComponentReference[],
): ProjectToolchainEvidenceV1[];
export function projectToolchainOutcome(
  evidence: ProjectToolchainEvidenceV1,
): ProjectToolchainOutcome;
