import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { foundationAudit } from "./foundation-audit.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";

export const repositoryKinds = [
  "library",
  "app",
  "service",
  "lab",
  "template",
  "infrastructure",
  "website",
  "data",
] as const;
export const repositoryStatuses = [
  "experimental",
  "active",
  "stable",
  "maintenance",
  "retiring",
  "archived",
] as const;

export type RepositoryKind = (typeof repositoryKinds)[number];
export type RepositoryStatus = (typeof repositoryStatuses)[number];

export type RepositoryMetadata = {
  schemaVersion: 1;
  id: string;
  kind: RepositoryKind;
  status: RepositoryStatus;
  summary?: string;
  dependsOn: string[];
  consumedBy: string[];
  supersedes: string[];
  replacedBy: string[];
};

type MetadataRead = {
  metadata?: RepositoryMetadata;
  diagnostics: Diagnostic[];
};

type StaleAgentPolicyFinding = {
  code: "legacy-agent-loop-config" | "legacy-agent-loop-policy";
  path: string;
  message: string;
};

const agentPolicyPaths = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/planning-workflow.md",
  "docs/agents/triage-labels.md",
] as const;

function stringField(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*$`, "m"));
  return match ? (JSON.parse(`"${match[1]}"`) as string) : undefined;
}

function numberField(source: string, name: string): number | undefined {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, "m"));
  return match ? Number(match[1]) : undefined;
}

function stringArrayField(source: string, name: string): string[] {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) return [];
  const values = match[1].match(/"(?:\\.|[^"])*"/g) ?? [];
  return values.map((value) => JSON.parse(value) as string);
}

function validRepositoryId(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validateRelations(name: string, values: string[], diagnostics: Diagnostic[]): void {
  for (const value of values) {
    if (validRepositoryId(value)) continue;
    diagnostics.push({
      code: "repository-metadata-relation-invalid",
      message: `${name} entry ${JSON.stringify(value)} must use owner/repository form`,
      path: ".repository.toml",
    });
  }
}

export function readRepositoryMetadata(root: string): MetadataRead {
  const path = join(root, ".repository.toml");
  if (!existsSync(path)) {
    return {
      diagnostics: [
        {
          code: "repository-metadata-missing",
          message: ".repository.toml is missing",
          path: ".repository.toml",
        },
      ],
    };
  }

  const source = readFileSync(path, "utf8");
  const diagnostics: Diagnostic[] = [];
  const schemaVersion = numberField(source, "schema_version");
  const id = stringField(source, "id");
  const kind = stringField(source, "kind");
  const status = stringField(source, "status");
  const summary = stringField(source, "summary");
  const dependsOn = stringArrayField(source, "depends_on");
  const consumedBy = stringArrayField(source, "consumed_by");
  const supersedes = stringArrayField(source, "supersedes");
  const replacedBy = stringArrayField(source, "replaced_by");

  if (schemaVersion !== 1) {
    diagnostics.push({
      code: "repository-metadata-schema-invalid",
      message: ".repository.toml must declare schema_version = 1",
      path: ".repository.toml",
    });
  }
  if (!id || !validRepositoryId(id)) {
    diagnostics.push({
      code: "repository-metadata-id-invalid",
      message: ".repository.toml id must use owner/repository form",
      path: ".repository.toml",
    });
  }
  if (!kind || !repositoryKinds.includes(kind as RepositoryKind)) {
    diagnostics.push({
      code: "repository-metadata-kind-invalid",
      message: `kind must be one of ${repositoryKinds.join(", ")}`,
      path: ".repository.toml",
    });
  }
  if (!status || !repositoryStatuses.includes(status as RepositoryStatus)) {
    diagnostics.push({
      code: "repository-metadata-status-invalid",
      message: `status must be one of ${repositoryStatuses.join(", ")}`,
      path: ".repository.toml",
    });
  }
  validateRelations("depends_on", dependsOn, diagnostics);
  validateRelations("consumed_by", consumedBy, diagnostics);
  validateRelations("supersedes", supersedes, diagnostics);
  validateRelations("replaced_by", replacedBy, diagnostics);

  if (diagnostics.length > 0 || !id || !kind || !status) return { diagnostics };
  return {
    metadata: {
      schemaVersion: 1,
      id,
      kind: kind as RepositoryKind,
      status: status as RepositoryStatus,
      summary,
      dependsOn: [...new Set(dependsOn)].sort(),
      consumedBy: [...new Set(consumedBy)].sort(),
      supersedes: [...new Set(supersedes)].sort(),
      replacedBy: [...new Set(replacedBy)].sort(),
    },
    diagnostics,
  };
}

export function repositoryMetadataCommand(root: string): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const resolved = resolve(root);
  const result = readRepositoryMetadata(resolved);
  return {
    schemaVersion: 1,
    operation: "repository-metadata",
    status: result.metadata ? "passed" : "failed",
    durationMs: Date.now() - started,
    data: {
      root: resolved,
      metadata: result.metadata ?? null,
    },
    diagnostics: result.diagnostics,
  };
}

function workflowNames(root: string): string[] {
  const directory = join(root, ".github", "workflows");
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory)
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

function hasPagesWorkflow(root: string, workflows: string[]): boolean {
  return workflows.some((name) => {
    if (/pages/i.test(name)) return true;
    try {
      const source = readFileSync(join(root, ".github", "workflows", name), "utf8");
      return /deploy-pages|github-pages|pages:\s*write/i.test(source);
    } catch {
      return false;
    }
  });
}

function repositoryDirectories(fleetRoot: string): string[] {
  try {
    return readdirSync(fleetRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(fleetRoot, entry.name))
      .filter((path) => existsSync(join(path, ".git")))
      .sort();
  } catch {
    return [];
  }
}

function staleAgentPolicyFindings(root: string): StaleAgentPolicyFinding[] {
  const findings: StaleAgentPolicyFinding[] = [];
  if (existsSync(join(root, ".agent-loop.toml"))) {
    findings.push({
      code: "legacy-agent-loop-config",
      path: ".agent-loop.toml",
      message:
        "root .agent-loop.toml belongs to the retired repository-local loop model; use direct skills or optional .agent-loop/config.toml orchestration instead",
    });
  }
  for (const path of agentPolicyPaths) {
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) continue;
    let source: string;
    try {
      source = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    const copiedSkillMapping = /mattpocock\/skills/.test(source);
    const legacyLoopLabels = /ready-for-agent/.test(source) && /agent-loop:/.test(source);
    if (!copiedSkillMapping && !legacyLoopLabels) continue;
    findings.push({
      code: "legacy-agent-loop-policy",
      path,
      message:
        "copied Agent Loop label/routing policy is stale shared policy; remove it or keep only repository-specific issue guidance",
    });
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

function foundationRequired(status: RepositoryStatus | undefined): boolean {
  return status !== "retiring" && status !== "archived";
}

function lifecycleBlockers(metadata: RepositoryMetadata | undefined): Diagnostic[] {
  if (!metadata) return [];
  const blockers: Diagnostic[] = [];
  if (metadata.status === "retiring" && metadata.replacedBy.length === 0) {
    blockers.push({
      code: "repository-retiring-without-replacement",
      message:
        "retiring repositories must declare replaced_by so consumers have a deterministic migration target",
      path: ".repository.toml",
    });
  }
  return blockers;
}

export function fleetAudit(fleetRoot: string): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(fleetRoot);
  const repositories = repositoryDirectories(root).map((repositoryRoot) => {
    const metadata = readRepositoryMetadata(repositoryRoot);
    const workflows = workflowNames(repositoryRoot);
    const mechanicalFoundation = foundationAudit(repositoryRoot);
    const foundation = {
      metadata: Boolean(metadata.metadata),
      environmentV1: existsSync(join(repositoryRoot, ".repository-environment.toml")),
      tooling: existsSync(join(repositoryRoot, ".coding-tooling.json")),
      conventions:
        existsSync(join(repositoryRoot, "conventions.json")) &&
        existsSync(join(repositoryRoot, "conventions.lock.json")),
      renovate: existsSync(join(repositoryRoot, "renovate.json")),
      agents: existsSync(join(repositoryRoot, "AGENTS.md")),
      workflows: workflows.length > 0,
      pages: hasPagesWorkflow(repositoryRoot, workflows),
      runtimeProfiler: existsSync(join(repositoryRoot, "profiles", "runtime-profiler")),
    };
    const enforceFoundation = foundationRequired(metadata.metadata?.status);
    const optionalFoundationKeys = new Set(["workflows", "pages", "runtimeProfiler"]);
    const observedMissing = Object.entries(foundation)
      .filter(([key, present]) => !present && !optionalFoundationKeys.has(key))
      .map(([key]) => key);
    const missing = enforceFoundation ? observedMissing : foundation.metadata ? [] : ["metadata"];
    const mechanicalComponents = mechanicalFoundation.data.components as
      | Record<string, { status?: unknown }>
      | undefined;
    const observedAuthoritativeMissing = Object.entries(mechanicalComponents ?? {})
      .filter(([, value]) => value?.status === "missing")
      .map(([key]) => key)
      .sort();
    const observedAuthoritativeBlockers = Object.entries(mechanicalComponents ?? {})
      .filter(([, value]) => value?.status === "invalid" || value?.status === "unsupported")
      .map(([key, value]) => ({ component: key, status: value.status }))
      .sort((left, right) => left.component.localeCompare(right.component));
    const authoritativeMissing = enforceFoundation ? observedAuthoritativeMissing : [];
    const authoritativeBlockers = enforceFoundation ? observedAuthoritativeBlockers : [];
    const observedStaleAgentPolicy = staleAgentPolicyFindings(repositoryRoot);
    const staleAgentPolicy = enforceFoundation ? observedStaleAgentPolicy : [];
    const lifecycleDiagnostics = lifecycleBlockers(metadata.metadata);
    const remediation = new Set<string>();
    if (authoritativeMissing.length > 0) {
      remediation.add(
        `bunx @moritzbrantner/platform-upgrader apply boring-foundation-v1 ${repositoryRoot}`,
      );
    }
    if (authoritativeBlockers.length > 0) {
      remediation.add(`coding-tooling foundation audit --root ${repositoryRoot} --json`);
    }
    if (!foundation.metadata)
      remediation.add(`classify ${basename(repositoryRoot)} and add .repository.toml`);
    if (lifecycleDiagnostics.length > 0)
      remediation.add(`resolve lifecycle metadata in ${join(repositoryRoot, ".repository.toml")}`);
    if (staleAgentPolicy.length > 0)
      remediation.add(`remove stale Agent Loop policy from ${basename(repositoryRoot)}`);

    return {
      name: basename(repositoryRoot),
      root: repositoryRoot,
      metadata: metadata.metadata ?? null,
      metadataDiagnostics: metadata.diagnostics,
      lifecycle: {
        status: metadata.metadata?.status ?? null,
        foundationRequired: enforceFoundation,
        blockers: lifecycleDiagnostics,
      },
      agentPolicy: {
        enforced: enforceFoundation,
        stale: staleAgentPolicy,
        observedStale: observedStaleAgentPolicy,
      },
      foundation,
      foundationAudit: {
        status: mechanicalFoundation.status,
        enforced: enforceFoundation,
        summary: mechanicalFoundation.data.summary ?? null,
        components: mechanicalComponents ?? {},
        missing: authoritativeMissing,
        blockers: authoritativeBlockers,
        observedMissing: observedAuthoritativeMissing,
        observedBlockers: observedAuthoritativeBlockers,
        diagnostics: mechanicalFoundation.diagnostics,
      },
      missing,
      observedMissing,
      remediation: [...remediation],
    };
  });

  let status: ResultStatus = "passed";
  const diagnostics: Diagnostic[] = [];
  if (repositories.length === 0) {
    status = "unavailable";
    diagnostics.push({
      code: "fleet-repositories-unavailable",
      message: `No direct child Git repositories found under ${root}`,
    });
  } else if (
    repositories.some(
      (repository) =>
        repository.missing.length > 0 ||
        repository.lifecycle.blockers.length > 0 ||
        repository.agentPolicy.stale.length > 0 ||
        repository.foundationAudit.missing.length > 0 ||
        repository.foundationAudit.blockers.length > 0,
    )
  ) {
    status = "failed";
  }

  return {
    schemaVersion: 1,
    operation: "fleet",
    status,
    durationMs: Date.now() - started,
    data: {
      root,
      repositoryCount: repositories.length,
      conformingRepositoryCount: repositories.filter(
        (repository) =>
          repository.missing.length === 0 &&
          repository.lifecycle.blockers.length === 0 &&
          repository.agentPolicy.stale.length === 0 &&
          repository.foundationAudit.missing.length === 0 &&
          repository.foundationAudit.blockers.length === 0,
      ).length,
      repositories,
    },
    diagnostics,
  };
}
