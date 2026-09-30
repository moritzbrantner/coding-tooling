import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TOML } from "bun";

import { discoverComponents, loadConfig } from "./core.ts";
import type { Component, Diagnostic, ResultEnvelope } from "./model.ts";
import { relativePosix, repositoryRoot, walkFiles } from "./shared.ts";

type RecordValue = Record<string, unknown>;
type EvidenceStatus = "complete" | "partial" | "unsupported" | "unavailable";
type Dependency = {
  name: string;
  kind: "direct" | "dev" | "build" | "optional" | "peer";
  source: "registry" | "workspace" | "path" | "git" | "unknown";
  declaration: string;
  features: string[];
  version?: string;
  package?: string;
  reference?: string;
  revision?: string;
  defaultFeatures?: boolean;
  target?: string;
  inheritedFrom?: string;
};
type ComponentEvidence = {
  id: string;
  name: string;
  path: string;
  ecosystem: "javascript" | "rust" | "dotnet" | "unknown";
  status: EvidenceStatus;
  dependencies: Dependency[];
  reason?: string;
};
type Boundary = {
  kind: "docker-service" | "subprocess" | "http" | "ffi" | "wasm";
  name: string;
  evidence: string[];
  component?: string;
  command?: string | string[];
  image?: string;
  dependsOn?: string[];
};
type Coverage = { feature: string; status: EvidenceStatus; reason?: string; evidence?: string[] };
type CargoManifest = { file: string; path: string; data: RecordValue };

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown, label: string): RecordValue {
  if (!record(value)) throw new Error(`${label} must be an object`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} must be a string array`);
  return sorted([...new Set(value)]);
}
function sorted<T>(values: readonly T[], compare?: (left: T, right: T) => number): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array with the repository ES2022 compiler lib.
  return [...values].sort(compare);
}
function within(path: string, scope: string): boolean {
  return scope === "." || path === scope || path.startsWith(`${scope}/`);
}
function dependencyOrder(left: Dependency, right: Dependency): number {
  return (
    left.name.localeCompare(right.name) ||
    left.kind.localeCompare(right.kind) ||
    left.declaration.localeCompare(right.declaration) ||
    (left.target ?? "").localeCompare(right.target ?? "")
  );
}
function packageSource(version: string): Dependency["source"] {
  if (version.startsWith("workspace:")) return "workspace";
  if (/^(?:file:|link:)/.test(version)) return "path";
  if (/^(?:git(?:\+|:)|github:|gitlab:|bitbucket:|ssh:)/.test(version)) return "git";
  if (/^[^@/\s]+\/[^/\s]+(?:#.*)?$/.test(version)) return "git";
  if (/^(?:https?:|\/|\.)/.test(version)) return "unknown";
  return /^(?:npm:|[~^<>=*\d]|[A-Za-z][\w.-]*$)/.test(version) ? "registry" : "unknown";
}
function packageEvidence(
  root: string,
  component: Component,
  boundaries: Boundary[],
): ComponentEvidence {
  const declaration = relativePosix(root, join(root, component.path, "package.json"));
  const manifest = object(JSON.parse(readFileSync(join(root, declaration), "utf8")), declaration);
  const dependencies: Dependency[] = [];
  const sections = [
    ["dependencies", "direct"],
    ["devDependencies", "dev"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ] as const;
  for (const [section, kind] of sections) {
    if (manifest[section] === undefined) continue;
    for (const [name, version] of Object.entries(
      object(manifest[section], `${declaration}:${section}`),
    )) {
      if (typeof version !== "string")
        throw new Error(`${declaration}:${section}.${name} must be a string`);
      dependencies.push({
        name,
        kind,
        source: packageSource(version),
        version,
        features: [],
        declaration,
      });
    }
  }
  if (manifest.scripts !== undefined) {
    for (const [name, command] of Object.entries(
      object(manifest.scripts, `${declaration}:scripts`),
    )) {
      if (typeof command !== "string")
        throw new Error(`${declaration}:scripts.${name} must be a string`);
      boundaries.push({
        kind: "subprocess",
        name,
        command,
        component: `package:${component.path}`,
        evidence: [declaration],
      });
    }
  }
  return {
    id: `package:${component.path}`,
    name: component.name,
    path: component.path,
    ecosystem: "javascript",
    status: dependencies.some(({ source }) => source === "unknown") ? "partial" : "complete",
    dependencies: sorted(dependencies, dependencyOrder),
  };
}

function workspaceDependency(
  manifests: CargoManifest[],
  manifest: CargoManifest,
  name: string,
): { data: unknown; declaration: string } | undefined {
  const workspace = sorted(
    manifests.filter(
      (candidate) => within(manifest.path, candidate.path) && record(candidate.data.workspace),
    ),
    (left, right) => right.path.length - left.path.length,
  )[0];
  if (!workspace || !record(workspace.data.workspace)) return undefined;
  const dependencies = workspace.data.workspace.dependencies;
  if (!record(dependencies) || !(name in dependencies)) return undefined;
  return { data: dependencies[name], declaration: workspace.file };
}
function cargoDependency(
  manifests: CargoManifest[],
  manifest: CargoManifest,
  name: string,
  value: unknown,
  kind: "direct" | "dev" | "build",
  target: string | undefined,
  diagnostics: Diagnostic[],
): Dependency {
  let specification: RecordValue =
    typeof value === "string" ? { version: value } : object(value, `${manifest.file}:${name}`);
  let inheritedFrom: string | undefined;
  let unresolved = false;
  if (specification.workspace === true) {
    const inherited = workspaceDependency(manifests, manifest, name);
    if (inherited) {
      const data =
        typeof inherited.data === "string"
          ? { version: inherited.data }
          : object(inherited.data, `${inherited.declaration}:${name}`);
      specification = {
        ...data,
        ...specification,
        features: [
          ...strings(data.features, `${name}:features`),
          ...strings(specification.features, `${name}:features`),
        ],
      };
      inheritedFrom = inherited.declaration;
    } else {
      unresolved = true;
      diagnostics.push({
        code: "dependency-workspace-unresolved",
        path: manifest.file,
        message: `${name} has no inspectable workspace dependency declaration`,
      });
    }
  }
  const source: Dependency["source"] = unresolved
    ? "unknown"
    : typeof specification.git === "string"
      ? "git"
      : typeof specification.path === "string"
        ? "path"
        : typeof specification.version === "string"
          ? "registry"
          : "unknown";
  return {
    name,
    kind: specification.optional === true ? "optional" : kind,
    source,
    declaration: manifest.file,
    features: strings(specification.features, `${manifest.file}:${name}:features`),
    ...(typeof specification.version === "string" ? { version: specification.version } : {}),
    ...(typeof specification.package === "string" ? { package: specification.package } : {}),
    ...(typeof specification.git === "string"
      ? { reference: specification.git }
      : typeof specification.path === "string"
        ? { reference: specification.path }
        : {}),
    ...(typeof specification.rev === "string" ? { revision: specification.rev } : {}),
    ...(typeof specification["default-features"] === "boolean"
      ? { defaultFeatures: specification["default-features"] }
      : {}),
    ...(target !== undefined ? { target } : {}),
    ...(inheritedFrom ? { inheritedFrom } : {}),
  };
}
function cargoEvidence(
  component: Component,
  components: Component[],
  manifests: CargoManifest[],
  diagnostics: Diagnostic[],
): ComponentEvidence {
  const dependencies: Dependency[] = [];
  const sections = [
    ["dependencies", "direct"],
    ["dev-dependencies", "dev"],
    ["build-dependencies", "build"],
  ] as const;
  const selected = manifests.filter((manifest) => {
    const owner = sorted(
      components.filter(
        (candidate) => candidate.kind === "rust" && within(manifest.path, candidate.path),
      ),
      (left, right) => right.path.length - left.path.length,
    )[0];
    return owner === component;
  });
  for (const manifest of selected) {
    const tables: Array<{ data: RecordValue; target?: string }> = [{ data: manifest.data }];
    if (manifest.data.target !== undefined) {
      for (const [target, data] of Object.entries(
        object(manifest.data.target, `${manifest.file}:target`),
      ))
        tables.push({ data: object(data, `${manifest.file}:target.${target}`), target });
    }
    for (const table of tables) {
      for (const [section, kind] of sections) {
        if (table.data[section] === undefined) continue;
        for (const [name, value] of Object.entries(
          object(table.data[section], `${manifest.file}:${section}`),
        ))
          dependencies.push(
            cargoDependency(manifests, manifest, name, value, kind, table.target, diagnostics),
          );
      }
    }
  }
  return {
    id: `rust:${component.path}`,
    name: component.name,
    path: component.path,
    ecosystem: "rust",
    status: dependencies.some(({ source }) => source === "unknown") ? "partial" : "complete",
    dependencies: sorted(dependencies, dependencyOrder),
  };
}

function composeEvidence(root: string, files: string[], boundaries: Boundary[]): Coverage {
  const names = new Set([
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
  ]);
  const selected = sorted(
    files.filter((file) => dirname(file) === root && names.has(basename(file))),
  );
  if (!selected.length)
    return {
      feature: "compose-services",
      status: "unavailable",
      reason: "No supported root Compose file was found",
    };
  let partial = false;
  for (const file of selected) {
    const declaration = relativePosix(root, file);
    const manifest = object(Bun.YAML.parse(readFileSync(file, "utf8")), declaration);
    if (manifest.include !== undefined) partial = true;
    if (manifest.services === undefined) {
      partial = true;
      continue;
    }
    for (const [name, value] of Object.entries(
      object(manifest.services, `${declaration}:services`),
    )) {
      const service = object(value, `${declaration}:services.${name}`);
      if (service.extends !== undefined || name.includes("${")) partial = true;
      const dependsOn =
        service.depends_on === undefined
          ? []
          : Array.isArray(service.depends_on)
            ? strings(service.depends_on, `${name}:depends_on`)
            : sorted(Object.keys(object(service.depends_on, `${name}:depends_on`)));
      if (dependsOn.some((dependency) => dependency.includes("${"))) partial = true;
      boundaries.push({
        kind: "docker-service",
        name,
        dependsOn,
        evidence: [declaration],
        ...(typeof service.image === "string" ? { image: service.image } : {}),
      });
    }
  }
  return {
    feature: "compose-services",
    status: partial ? "partial" : "complete",
    evidence: selected.map((file) => relativePosix(root, file)),
    ...(partial
      ? { reason: "Includes, extensions or interpolated relationships are not resolved" }
      : {}),
  };
}

function declaredBoundaryEvidence(
  root: string,
  files: string[],
  manifests: CargoManifest[],
  boundaries: Boundary[],
): Coverage[] {
  const openApiFiles = files.filter((file) => {
    const name = basename(file).toLowerCase();
    return (
      name.endsWith(".json") &&
      (name === "openapi.json" || name === "swagger.json" || name.startsWith("openapi."))
    );
  });
  const httpEvidence: string[] = [];
  for (const file of openApiFiles) {
    const declaration = relativePosix(root, file);
    const document = object(JSON.parse(readFileSync(file, "utf8")), declaration);
    if (
      !(typeof document.openapi === "string" && /^3\.\d+\.\d+$/.test(document.openapi)) &&
      document.swagger !== "2.0"
    )
      continue;
    httpEvidence.push(declaration);
    if (document.servers !== undefined) {
      if (!Array.isArray(document.servers))
        throw new Error(`${declaration}:servers must be an array`);
      for (const server of document.servers) {
        const value = object(server, `${declaration}:server`);
        if (typeof value.url !== "string")
          throw new Error(`${declaration}:server.url must be a string`);
        boundaries.push({ kind: "http", name: value.url, evidence: [declaration] });
      }
    }
  }
  const nativeEvidence: string[] = [];
  for (const manifest of manifests) {
    nativeEvidence.push(manifest.file);
    if (record(manifest.data.package) && typeof manifest.data.package.links === "string")
      boundaries.push({
        kind: "ffi",
        name: manifest.data.package.links,
        evidence: [manifest.file],
      });
    if (record(manifest.data.lib)) {
      for (const kind of strings(manifest.data.lib["crate-type"], `${manifest.file}:crate-type`)) {
        if (kind !== "cdylib" && kind !== "staticlib") continue;
        const name =
          record(manifest.data.package) && typeof manifest.data.package.name === "string"
            ? manifest.data.package.name
            : manifest.path;
        boundaries.push({ kind: "ffi", name: `${name}:${kind}`, evidence: [manifest.file] });
      }
    }
  }
  for (const file of files.filter(
    (candidate) =>
      basename(dirname(candidate)) === ".cargo" &&
      ["config", "config.toml"].includes(basename(candidate)),
  )) {
    const declaration = relativePosix(root, file);
    const config = object(TOML.parse(readFileSync(file, "utf8")), declaration);
    nativeEvidence.push(declaration);
    if (!record(config.build) || config.build.target === undefined) continue;
    const targets =
      typeof config.build.target === "string"
        ? [config.build.target]
        : strings(config.build.target, `${declaration}:build.target`);
    for (const target of targets.filter((candidate) => /^wasm(?:32|64)-/.test(candidate)))
      boundaries.push({ kind: "wasm", name: target, evidence: [declaration] });
  }
  return [
    {
      feature: "http-boundaries",
      status: httpEvidence.length ? "partial" : "unavailable",
      evidence: sorted(httpEvidence),
      reason:
        "Only explicit document-level OpenAPI server URLs are collected; operation overrides, Swagger hosts and other service configuration are unsupported",
    },
    {
      feature: "ffi-wasm-boundaries",
      status: nativeEvidence.length ? "partial" : "unavailable",
      evidence: sorted(nativeEvidence),
      reason:
        "Only Cargo native links, exported artifact kinds and explicit WASM build targets are collected; source-level FFI and runtime bridges are unsupported",
    },
  ];
}

export function inspectDependencies(
  root = repositoryRoot(),
  options: { component?: string; configPath?: string } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  root = resolve(root);
  try {
    const config = loadConfig(root, options.configPath);
    const files = walkFiles(root, 4);
    for (const file of files.filter((candidate) => basename(candidate) === "package.json"))
      object(JSON.parse(readFileSync(file, "utf8")), relativePosix(root, file));
    const components = discoverComponents(root, config);
    const selected = components.filter(
      (component) =>
        !options.component ||
        component.name === options.component ||
        component.path === options.component,
    );
    if (options.component && !selected.length)
      throw new Error(`Unknown component: ${options.component}`);
    const manifests: CargoManifest[] = components.some((component) => component.kind === "rust")
      ? files
          .filter((file) => basename(file) === "Cargo.toml")
          .map((file) => ({
            file: relativePosix(root, file),
            path: relativePosix(root, dirname(file)),
            data: object(TOML.parse(readFileSync(file, "utf8")), relativePosix(root, file)),
          }))
      : [];
    const diagnostics: Diagnostic[] = [];
    const boundaries: Boundary[] = [];
    const evidence = selected.map((component): ComponentEvidence => {
      if (component.kind === "package") return packageEvidence(root, component, boundaries);
      if (component.kind === "rust")
        return cargoEvidence(component, components, manifests, diagnostics);
      return {
        id: `${component.kind}:${component.path}`,
        name: component.name,
        path: component.path,
        ecosystem: component.kind === "dotnet" ? "dotnet" : "unknown",
        status: "unsupported",
        dependencies: [],
        reason: "No static dependency adapter is available for this component kind",
      };
    });
    for (const component of selected) {
      const commands = {
        ...config.capabilityCommands?.[component.name],
        ...config.capabilityCommands?.[component.path],
      };
      for (const [name, command] of Object.entries(commands))
        boundaries.push({
          kind: "subprocess",
          name,
          command,
          component: `${component.kind}:${component.path}`,
          evidence: [options.configPath ?? ".coding-tooling.json"],
        });
    }
    const coverage: Coverage[] = [
      composeEvidence(root, files, boundaries),
      ...declaredBoundaryEvidence(root, files, manifests, boundaries),
      ...["transitive-dependencies", "source-references"].map((feature): Coverage => ({
        feature,
        status: "unsupported",
        reason: "This static inspection version does not collect this evidence",
      })),
    ];
    const orderedBoundaries = sorted(
      boundaries,
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name) ||
        (left.component ?? "").localeCompare(right.component ?? "") ||
        left.evidence.join().localeCompare(right.evidence.join()),
    );
    return {
      schemaVersion: 1,
      operation: "dependencies",
      status:
        evidence.some(({ status }) => status === "complete" || status === "partial") ||
        boundaries.length
          ? "passed"
          : "unavailable",
      durationMs: Date.now() - started,
      data: {
        root,
        reportVersion: 1,
        components: evidence,
        boundaries: orderedBoundaries,
        coverage: sorted(coverage, (left, right) => left.feature.localeCompare(right.feature)),
      },
      diagnostics: sorted(
        diagnostics,
        (left, right) =>
          (left.path ?? "").localeCompare(right.path ?? "") ||
          (left.code ?? "").localeCompare(right.code ?? "") ||
          left.message.localeCompare(right.message),
      ),
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "dependencies",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, reportVersion: 1 },
      diagnostics: [
        {
          code: "dependency-inspection-invalid",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
