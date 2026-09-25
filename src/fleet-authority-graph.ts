import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";

export const FLEET_AUTHORITY_GRAPH_VERSION = "coding-tooling/fleet-authority-graph/v2" as const;

export type AuthorityBoundaries = {
  owns: string[];
  adapts: string[];
  nonAuthoritative: string[];
  prohibitedWriteBack: string[];
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

export function fleetAuthorityGraph(fleetRoot: string): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(fleetRoot);
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
    return {
      id,
      root: repositoryRoot,
      metadata: metadataRead.metadata ?? null,
      metadataDiagnostics: metadataRead.diagnostics,
      authority: authority ?? null,
    };
  });

  const duplicateOwners = [...owners.entries()]
    .filter(([, repositories]) => repositories.length > 1)
    .map(([capability, repositories]) => ({
      capability,
      repositories: [...repositories].sort(),
    }))
    .sort((left, right) => left.capability.localeCompare(right.capability));

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
  const status: ResultStatus = repositories.length === 0 ? "unavailable" : "passed";
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
      conflicts: duplicateOwners.map((duplicate) => ({
        kind: "duplicate-authority-owner",
        capability: duplicate.capability,
        repositories: duplicate.repositories,
      })),
      coverage: {
        repositoryCount: repositories.length,
        authorityDeclared: repositories.length - missingAuthoritySections.length,
        missingAuthoritySections,
      },
      notes: [
        "This graph is descriptive metadata, not a validation or merge gate.",
        "Duplicate authoritative owners are exposed as conflicts without changing graph status.",
        "Source-development checkout state and revision verification belong to explicit source-dependency diagnostics, not this graph.",
        "Missing authority sections are adoption gaps; repositories should not invent ownership declarations merely to improve coverage.",
      ],
    },
    diagnostics,
  };
}
