import { NORMALIZED_EVIDENCE_SCHEMA_VERSION } from "./evidence-model.js";

export function createProjectManifestEvidence(input) {
  if (input.collector !== "filesystem" && input.collector !== "github")
    throw new Error(`Unsupported project evidence collector: ${String(input.collector)}`);
  if (input.kind !== "rust" && input.kind !== "dotnet")
    throw new Error(`Unsupported project evidence kind: ${String(input.kind)}`);
  if (typeof input.name !== "string" || !input.name)
    throw new Error("Project evidence requires a component name");
  if (typeof input.path !== "string" || !input.path)
    throw new Error("Project evidence requires a component path");

  const manifestPaths = [
    ...new Set((input.manifestPaths ?? []).filter((path) => typeof path === "string" && path)),
  ].toSorted();

  return {
    schemaVersion: NORMALIZED_EVIDENCE_SCHEMA_VERSION,
    component: {
      name: input.name,
      path: input.path,
      kind: input.kind,
    },
    facts: {
      manifests: {
        status: manifestPaths.length ? "available" : "incomplete",
        value: manifestPaths,
        provenance: manifestPaths.map((path) => ({ collector: input.collector, path })),
      },
    },
  };
}

export function projectManifestSemantics(evidence) {
  if (evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION)
    throw new Error("Unsupported normalized project evidence schema");
  if (evidence?.component?.kind !== "rust" && evidence?.component?.kind !== "dotnet")
    throw new Error("Unsupported normalized project evidence kind");

  return {
    kind: evidence.component.kind,
    manifestStatus: evidence.facts.manifests.status,
    manifestPaths: [...evidence.facts.manifests.value].toSorted(),
  };
}
