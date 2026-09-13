import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { readJson, type CommandResult, runCommand } from "./shared.ts";

export const FLEET_AUTHORITY_GRAPH_VERSION = "coding-tooling/fleet-authority-graph/v1" as const;

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export type AuthorityBoundaries = {
  owns: string[];
  adapts: string[];
  nonAuthoritative: string[];
  prohibitedWriteBack: string[];
};

type SourceDependencyConfig = {
  schemaVersion?: unknown;
  cargo?: {
    patches?: unknown;
  };
};

type SourcePatch = {
  package?: unknown;
  git?: unknown;
  rev?: unknown;
  localPath?: unknown;
};

function values(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((entry) => entry.trim().replace(/^`|`$/g, ""))
        .filter(Boolean),
    ),
  ].sort();
}

export function parseAuthorityBoundaries(source: string): AuthorityBoundaries | undefined {
  const heading = /^## Authority boundaries\s*$/im.exec(source);
  if (!heading) return undefined;
  const remainder = source.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s+/m.exec(remainder);
  const section = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
  const result: AuthorityBoundaries = {
    owns: [],
    adapts: [],
    nonAuthoritative: [],
    prohibitedWriteBack: [],
  };
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(
      /^[-*]\s+(Owns|Adapts|Non-authoritative|Prohibited write-back):\s*(.+?)\s*$/i,
    );
    if (!match) continue;
    const label = match[1]!.toLowerCase();
    const parsed = label === "prohibited write-back" ? [match[2]!.trim()] : values(match[2]!);
    if (label === "owns") result.owns.push(...parsed);
    else if (label === "adapts") result.adapts.push(...parsed);
    else if (label === "non-authoritative") result.nonAuthoritative.push(...parsed);
    else result.prohibitedWriteBack.push(...parsed);
  }
  result.owns = [...new Set(result.owns)].sort();
  result.adapts = [...new Set(result.adapts)].sort();
  result.nonAuthoritative = [...new Set(result.nonAuthoritative)].sort();
  result.prohibitedWriteBack = [...new Set(result.prohibitedWriteBack)].sort();
  return result;
}

function repositoryDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((path) => existsSync(join(path, ".git")))
      .sort();
  } catch {
    return [];
  }
}

function githubRepository(value: string): string | null {
  const match = value.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function sourceDependencyEvidence(
  root: string,
  runner: Runner,
): { entries: Array<Record<string, unknown>>; diagnostics: Diagnostic[] } {
  const path = join(root, ".coding-tooling.source-deps.json");
  if (!existsSync(path)) return { entries: [], diagnostics: [] };
  const parsed = readJson<SourceDependencyConfig>(path);
  if (!parsed || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)) {
    return {
      entries: [],
      diagnostics: [
        {
          code: "authority-graph-source-deps-invalid",
          message: ".coding-tooling.source-deps.json has an unsupported schema",
          path: ".coding-tooling.source-deps.json",
        },
      ],
    };
  }
  const patches = Array.isArray(parsed.cargo?.patches)
    ? (parsed.cargo!.patches as SourcePatch[])
    : [];
  const entries: Array<Record<string, unknown>> = [];
  const diagnostics: Diagnostic[] = [];
  for (const patch of patches) {
    const packageName = typeof patch.package === "string" ? patch.package : "";
    const git = typeof patch.git === "string" ? patch.git : "";
    const rev = typeof patch.rev === "string" ? patch.rev.toLowerCase() : "";
    const localPath = typeof patch.localPath === "string" ? patch.localPath : null;
    if (!packageName || !git || !/^[0-9a-f]{40}$/i.test(rev)) {
      diagnostics.push({
        code: "authority-graph-source-patch-invalid",
        message: `Source patch ${packageName || "<unnamed>"} lacks package, Git URL, or exact revision`,
        path: ".coding-tooling.source-deps.json",
      });
      continue;
    }
    let actualRevision: string | null = null;
    if (localPath) {
      const resolvedLocal = resolve(root, localPath);
      if (existsSync(resolvedLocal)) {
        const command = runner("git", ["-C", resolvedLocal, "rev-parse", "HEAD"], root);
        if (command.status === 0 && /^[0-9a-f]{40}$/i.test(command.stdout.trim())) {
          actualRevision = command.stdout.trim().toLowerCase();
          if (actualRevision !== rev) {
            diagnostics.push({
              code: "authority-graph-source-revision-drift",
              message: `${packageName} local source is ${actualRevision}, expected ${rev}`,
              path: ".coding-tooling.source-deps.json",
            });
          }
        } else {
          diagnostics.push({
            code: "authority-graph-source-revision-unavailable",
            message: `Could not resolve local source revision for ${packageName}`,
            path: ".coding-tooling.source-deps.json",
          });
        }
      }
    }
    entries.push({
      package: packageName,
      repository: githubRepository(git),
      git,
      declaredRevision: rev,
      localPath,
      actualRevision,
      exactRevisionSatisfied: actualRevision === null ? null : actualRevision === rev,
    });
  }
  entries.sort((left, right) => String(left.package).localeCompare(String(right.package)));
  return { entries, diagnostics };
}

export function fleetAuthorityGraph(
  fleetRoot: string,
  dependencies: { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(fleetRoot);
  const runner = dependencies.run ?? runCommand;
  const diagnostics: Diagnostic[] = [];
  const owners = new Map<string, string[]>();
  const repositories = repositoryDirectories(root).map((repositoryRoot) => {
    const metadataRead = readRepositoryMetadata(repositoryRoot);
    const id = metadataRead.metadata?.id ?? basename(repositoryRoot);
    let authority: AuthorityBoundaries | undefined;
    const agentsPath = join(repositoryRoot, "AGENTS.md");
    if (existsSync(agentsPath)) {
      try {
        authority = parseAuthorityBoundaries(readFileSync(agentsPath, "utf8"));
      } catch {
        authority = undefined;
      }
    }
    for (const capability of authority?.owns ?? []) {
      const current = owners.get(capability) ?? [];
      current.push(id);
      owners.set(capability, current);
    }
    const sourceDependencies = sourceDependencyEvidence(repositoryRoot, runner);
    diagnostics.push(
      ...sourceDependencies.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${id}: ${diagnostic.message}`,
      })),
    );
    return {
      id,
      root: repositoryRoot,
      metadata: metadataRead.metadata ?? null,
      metadataDiagnostics: metadataRead.diagnostics,
      authority: authority ?? null,
      sourceDependencies: sourceDependencies.entries,
    };
  });

  const duplicateOwners = [...owners.entries()]
    .filter(([, repositories]) => repositories.length > 1)
    .map(([capability, repositories]) => ({
      capability,
      repositories: [...repositories].sort(),
    }))
    .sort((left, right) => left.capability.localeCompare(right.capability));
  for (const duplicate of duplicateOwners) {
    diagnostics.push({
      code: "authority-graph-duplicate-owner",
      message: `${duplicate.capability} is declared authoritative by ${duplicate.repositories.join(", ")}`,
    });
  }

  const authorityOwners = Object.fromEntries(
    [...owners.entries()]
      .map(([capability, repositories]) => [capability, [...repositories].sort()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const dependencyEdges = repositories
    .flatMap((repository) => {
      const metadata = repository.metadata as { dependsOn?: string[] } | null;
      return (metadata?.dependsOn ?? []).map((target) => ({
        from: repository.id,
        to: target,
        kind: "depends-on" as const,
      }));
    })
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const adapterEdges = repositories
    .flatMap((repository) => {
      const authority = repository.authority as AuthorityBoundaries | null;
      return (authority?.adapts ?? []).map((capability) => ({
        repository: repository.id,
        capability,
        owners: authorityOwners[capability] ?? [],
      }));
    })
    .sort(
      (left, right) =>
        left.repository.localeCompare(right.repository) ||
        left.capability.localeCompare(right.capability),
    );
  const missingAuthoritySections = repositories
    .filter((repository) => repository.authority === null)
    .map((repository) => repository.id)
    .sort();
  const revisionDrift = diagnostics.some((diagnostic) =>
    ["authority-graph-source-revision-drift", "authority-graph-source-patch-invalid"].includes(
      diagnostic.code ?? "",
    ),
  );
  const status: ResultStatus =
    repositories.length === 0
      ? "unavailable"
      : duplicateOwners.length > 0 || revisionDrift
        ? "failed"
        : "passed";
  if (repositories.length === 0) {
    diagnostics.push({
      code: "authority-graph-repositories-unavailable",
      message: `No direct child Git repositories found under ${root}`,
    });
  }

  return {
    schemaVersion: 1,
    operation: "fleet-authority-graph",
    status,
    durationMs: Date.now() - started,
    data: {
      schemaVersion: FLEET_AUTHORITY_GRAPH_VERSION,
      root,
      repositories,
      authorityOwners,
      dependencyEdges,
      adapterEdges,
      duplicateOwners,
      coverage: {
        repositoryCount: repositories.length,
        authorityDeclared: repositories.length - missingAuthoritySections.length,
        missingAuthoritySections,
      },
      notes: [
        "Missing authority sections are adoption gaps, not automatic failures.",
        "Duplicate authoritative owners and mismatched local source revisions fail the graph.",
        "Source dependency revisions come from committed source-development configuration and are checked against local source checkouts when present.",
      ],
    },
    diagnostics,
  };
}
