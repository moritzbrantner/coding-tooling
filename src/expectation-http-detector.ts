import { loadConfig } from "./core.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import type { DetectorContext } from "./expectation-package-context.ts";
import { publicContractDeclarations } from "./public-contract.ts";

export function missingHttpContractEvidenceFindings({ root }: DetectorContext): RawFinding[] {
  const config = loadConfig(root);
  const { surfaces, verifications, manifestPath } = publicContractDeclarations(
    root,
    config.contracts?.manifest,
  );
  return surfaces
    .filter((surface) => surface.kind === "http-operation")
    .filter(
      (surface) =>
        !verifications.some(
          (verification) =>
            verification.surface === surface.id &&
            verification.kind !== "reachability" &&
            verification.capability.startsWith("test") &&
            verification.case,
        ),
    )
    .map((surface) => ({
      subject: {
        kind: "file",
        key: surface.id,
        path: surface.declaration ?? manifestPath,
        description: `Public HTTP operation ${surface.subject}`,
      },
      requirement: {
        kind: "test",
        key: surface.id,
        description: "declare an exact behavioral case for the public HTTP operation",
        expectedArtifact: manifestPath,
      },
      message: `${surface.subject} has no explicit strong behavioral case mapping`,
      evidence: [
        {
          kind: "manifest",
          path: surface.declaration ?? manifestPath,
          detail: `Declared public HTTP operation ${surface.id}`,
        },
        {
          kind: "config",
          path: manifestPath,
          detail:
            "No strong test-capability mapping declares an exact case ID and behavior dimension for this operation",
        },
      ],
      relatedFiles: [...new Set([surface.declaration ?? manifestPath, manifestPath])],
      verification: [],
    }));
}
