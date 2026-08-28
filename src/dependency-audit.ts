import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ResultEnvelope } from "./model.ts";
import { readJson, relativePosix } from "./shared.ts";

export type ArchitectureLayer = "foundation" | "domain" | "adapter" | "application" | "tooling";
export type DependencyRelation = "foundation" | "capability" | "adapter" | "tooling" | "optional";

type ArchitectureDependency = {
  repository: string;
  layer: ArchitectureLayer;
  relation?: DependencyRelation;
};

type OwnershipRecord = {
  package: string;
  sourceRepository: string;
  releaseRepository: string;
  mode?: "canonical" | "compatibility";
};

type DependencyAuditConfig = {
  schemaVersion: 1;
  repository: {
    name: string;
    layer: ArchitectureLayer;
  };
  dependencies?: ArchitectureDependency[];
  allowedSideways?: string[];
  maxExactSourceRepositories?: number;
  maxPackagesPerSourceRepository?: number;
  legacyRepositories?: Record<string, string>;
  ownership?: OwnershipRecord[];
  graph?: Record<string, string[]>;
};

type SourcePatch = {
  package?: string;
  git?: string;
};

type SourceDependencyConfig = {
  cargo?: {
    patches?: SourcePatch[];
  };
};

export type DependencyFinding = {
  severity: "error" | "warning";
  code: string;
  message: string;
  repository?: string;
  packages?: string[];
};

function repositoryFromGit(value: string): string | undefined {
  const normalized = value.replace(/\.git$/, "");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function sourcePatchRepositories(root: string): Map<string, string[]> {
  const sourcePath = resolve(root, ".coding-tooling.source-deps.json");
  const sourceConfig = readJson<SourceDependencyConfig>(sourcePath);
  const grouped = new Map<string, string[]>();

  for (const patch of sourceConfig?.cargo?.patches ?? []) {
    if (!patch.git) continue;
    const repository = repositoryFromGit(patch.git);
    if (!repository) continue;
    const packages = grouped.get(repository) ?? [];
    packages.push(patch.package ?? "<unknown>");
    grouped.set(repository, packages);
  }
  return grouped;
}

function findCycles(graph: Record<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const fingerprints = new Set<string>();

  function visit(node: string): void {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node];
      const fingerprint = [...new Set(cycle)].sort().join("|");
      if (!fingerprints.has(fingerprint)) {
        fingerprints.add(fingerprint);
        cycles.push(cycle);
      }
      return;
    }

    visiting.add(node);
    path.push(node);
    for (const dependency of graph[node] ?? []) visit(dependency);
    path.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of Object.keys(graph).sort()) visit(node);
  return cycles;
}

function validateDirection(
  currentLayer: ArchitectureLayer,
  dependency: ArchitectureDependency,
  allowedSideways: Set<string>,
): DependencyFinding | undefined {
  if (dependency.relation === "adapter" || dependency.relation === "tooling") return undefined;

  if (
    currentLayer === "foundation" &&
    dependency.layer !== "foundation" &&
    dependency.layer !== "tooling"
  ) {
    return {
      severity: "error",
      code: "dependency-upward-from-foundation",
      repository: dependency.repository,
      message: `foundation repository depends upward on ${dependency.layer} repository ${dependency.repository}`,
    };
  }

  if (
    currentLayer === "domain" &&
    dependency.layer === "domain" &&
    !allowedSideways.has(dependency.repository)
  ) {
    return {
      severity: "error",
      code: "domain-sideways-dependency",
      repository: dependency.repository,
      message: `domain repository depends sideways on domain implementation ${dependency.repository}; use a lower contract or explicit adapter`,
    };
  }

  if (currentLayer === "domain" && dependency.layer === "application") {
    return {
      severity: "error",
      code: "domain-depends-on-application",
      repository: dependency.repository,
      message: `domain repository depends upward on application ${dependency.repository}`,
    };
  }

  if (currentLayer === "adapter" && dependency.layer === "application") {
    return {
      severity: "error",
      code: "adapter-depends-on-application",
      repository: dependency.repository,
      message: `adapter depends upward on application ${dependency.repository}`,
    };
  }

  return undefined;
}

function loadConfig(path: string): DependencyAuditConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DependencyAuditConfig;
  } catch {
    return undefined;
  }
}

export function auditDependencies(
  root: string,
  configPath?: string,
  strict = false,
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  const path = resolve(root, configPath ?? ".coding-tooling.dependencies.json");
  const config = loadConfig(path);

  if (!config) {
    return {
      schemaVersion: 1,
      operation: "dependencies",
      status: "unavailable",
      durationMs: Math.round(performance.now() - started),
      data: { configPath: relativePosix(root, path) },
      diagnostics: [
        {
          code: "dependency-config-unavailable",
          message: `dependency architecture config not found or invalid: ${relativePosix(root, path)}`,
        },
      ],
    };
  }

  const validLayers: ArchitectureLayer[] = [
    "foundation",
    "domain",
    "adapter",
    "application",
    "tooling",
  ];
  const validRepository =
    config.repository &&
    typeof config.repository.name === "string" &&
    config.repository.name.length > 0 &&
    validLayers.includes(config.repository.layer);
  if (config.schemaVersion !== 1 || !validRepository) {
    return {
      schemaVersion: 1,
      operation: "dependencies",
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      data: {
        configPath: relativePosix(root, path),
        findings: [
          {
            severity: "error",
            code: "invalid-dependency-config",
            message:
              "dependency architecture config must use schemaVersion 1 and declare a valid repository name/layer",
          },
        ],
        errors: 1,
        warnings: 0,
        strict,
      },
      diagnostics: [
        {
          code: "invalid-dependency-config",
          message:
            "dependency architecture config must use schemaVersion 1 and declare a valid repository name/layer",
        },
      ],
    };
  }

  const findings: DependencyFinding[] = [];
  const dependencies = new Map(
    (config.dependencies ?? []).map((dependency) => [dependency.repository, dependency]),
  );
  const allowedSideways = new Set(config.allowedSideways ?? []);
  for (const dependency of dependencies.values()) {
    const finding = validateDirection(config.repository.layer, dependency, allowedSideways);
    if (finding) findings.push(finding);
  }

  const sourceRepositories = sourcePatchRepositories(root);
  for (const [repository, packages] of sourceRepositories) {
    const canonical = config.legacyRepositories?.[repository];
    if (canonical) {
      findings.push({
        severity: "error",
        code: "legacy-source-repository",
        repository,
        packages,
        message: `source override still targets legacy ${repository}; use canonical owner ${canonical}`,
      });
    }
    if (!dependencies.has(repository)) {
      findings.push({
        severity: "error",
        code: "undeclared-source-repository",
        repository,
        packages,
        message: `exact source workspace includes undeclared repository ${repository}`,
      });
    }
  }

  const maxExact = config.maxExactSourceRepositories ?? 2;
  if (sourceRepositories.size > maxExact) {
    findings.push({
      severity: "warning",
      code: "wide-exact-source-workspace",
      message: `exact source workspace spans ${sourceRepositories.size} upstream repositories (budget ${maxExact}); treat this as explicit architecture/migration work`,
    });
  }

  if (config.repository.layer === "application") {
    const packageLimit = config.maxPackagesPerSourceRepository ?? 5;
    for (const [repository, packages] of sourceRepositories) {
      if (packages.length > packageLimit) {
        findings.push({
          severity: "warning",
          code: "capability-topology-leak",
          repository,
          packages,
          message: `application source workspace knows ${packages.length} packages from ${repository}; prefer a coarser capability surface`,
        });
      }
    }
  }

  for (const ownership of config.ownership ?? []) {
    if (ownership.mode === "compatibility") continue;
    if (ownership.sourceRepository !== ownership.releaseRepository) {
      findings.push({
        severity: "error",
        code: "split-package-ownership",
        message: `${ownership.package} has source owner ${ownership.sourceRepository} but release owner ${ownership.releaseRepository}`,
      });
    }
  }

  for (const cycle of findCycles(config.graph ?? {})) {
    findings.push({
      severity: "error",
      code: "repository-dependency-cycle",
      message: `repository dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const failed = errors > 0 || (strict && warnings > 0);

  return {
    schemaVersion: 1,
    operation: "dependencies",
    status: failed ? "failed" : "passed",
    durationMs: Math.round(performance.now() - started),
    data: {
      configPath: relativePosix(root, path),
      repository: config.repository,
      exactSourceRepositories: Object.fromEntries(sourceRepositories),
      findings,
      errors,
      warnings,
      strict,
    },
    diagnostics: findings.map((finding) => ({ code: finding.code, message: finding.message })),
  };
}
