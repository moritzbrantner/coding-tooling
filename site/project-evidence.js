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
  const complete = input.complete !== false;

  return {
    schemaVersion: NORMALIZED_EVIDENCE_SCHEMA_VERSION,
    component: {
      name: input.name,
      path: input.path,
      kind: input.kind,
    },
    facts: {
      manifests: {
        status: manifestPaths.length && complete ? "available" : "incomplete",
        value: manifestPaths,
        provenance: manifestPaths.map((path) => ({ collector: input.collector, path })),
      },
    },
  };
}

export function collectGithubProjectManifestEvidence(snapshot, components) {
  const manifestPaths = (snapshot?.tree ?? [])
    .filter((entry) => entry?.type === "blob")
    .map((entry) => entry?.path)
    .filter(
      (path) =>
        typeof path === "string" &&
        (baseName(path) === "Cargo.toml" || path.endsWith(".sln") || path.endsWith(".csproj")),
    );

  return (components ?? [])
    .filter((component) => component?.kind === "rust" || component?.kind === "dotnet")
    .map((component) =>
      createProjectManifestEvidence({
        collector: "github",
        name: component.name,
        path: component.path,
        kind: component.kind,
        manifestPaths: manifestPaths.filter((manifestPath) =>
          manifestBelongsToComponent(manifestPath, component.path, component.kind),
        ),
        complete: snapshot?.treeTruncated !== true,
      }),
    );
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

function manifestBelongsToComponent(manifestPath, componentPath, kind) {
  const manifestDirectory = directoryName(manifestPath);
  if (manifestDirectory !== componentPath) return false;
  if (kind === "rust") return baseName(manifestPath) === "Cargo.toml";
  return manifestPath.endsWith(".sln") || manifestPath.endsWith(".csproj");
}

function directoryName(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index) || ".";
}

function baseName(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}
