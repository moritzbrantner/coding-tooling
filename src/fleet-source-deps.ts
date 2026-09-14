import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import { reconcileTextFile, reconciliationChanged } from "./reconciliation.ts";
import {
  defaultSourceDependencyConfigPath,
  readSourceDependencyConfig,
  type CargoSourcePatch,
  type LoadedSourceDependencyConfig,
} from "./source-deps.ts";
import { verifySourceDependencyGraph } from "./source-graph.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type V3Repository = {
  git: string;
  rev: string;
  localPath: string;
  packages: Array<{ package: string; path?: string }>;
};

function posix(value: string): string {
  return value.replaceAll("\\", "/");
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

function canonicalRepository(git: string): string {
  return git.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function gitRoot(path: string, cwd: string, runner: Runner): string | null {
  const result = runner("git", ["-C", path, "rev-parse", "--show-toplevel"], cwd);
  return result.status === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : null;
}

function migrationConfig(
  root: string,
  loaded: LoadedSourceDependencyConfig,
  runner: Runner,
): { content?: string; reason?: string } {
  if (loaded.schemaVersion === 3) return {};
  const byRepository = new Map<string, CargoSourcePatch[]>();
  for (const patch of loaded.patches) {
    const key = canonicalRepository(patch.git);
    const current = byRepository.get(key) ?? [];
    current.push(patch);
    byRepository.set(key, current);
  }

  const repositories: V3Repository[] = [];
  for (const patches of byRepository.values()) {
    const revisions = [...new Set(patches.map((patch) => patch.rev.toLowerCase()))];
    if (revisions.length !== 1) {
      return { reason: `${patches[0]!.git} uses multiple revisions inside one consumer` };
    }
    if (patches.some((patch) => !patch.localPath)) {
      return { reason: `${patches[0]!.git} has no complete local-path evidence for schema-v3 migration` };
    }

    const packageRoots = patches.map((patch) => {
      const packagePath = resolve(root, patch.localPath!);
      return { patch, packagePath, repositoryRoot: gitRoot(packagePath, root, runner) };
    });
    if (packageRoots.some((entry) => entry.repositoryRoot === null)) {
      return { reason: `${patches[0]!.git} local repository root cannot be resolved` };
    }
    const roots = [...new Set(packageRoots.map((entry) => entry.repositoryRoot!))];
    if (roots.length !== 1) {
      return { reason: `${patches[0]!.git} package paths resolve to multiple Git repositories` };
    }
    const repositoryRoot = roots[0]!;
    const packages = packageRoots
      .map(({ patch, packagePath }) => {
        const packageRelative = posix(relative(repositoryRoot, packagePath));
        if (packageRelative.startsWith("../") || packageRelative === "..") {
          throw new Error(`${patch.package} is outside ${repositoryRoot}`);
        }
        return {
          package: patch.package,
          ...(packageRelative && packageRelative !== "." ? { path: packageRelative } : {}),
        };
      })
      .sort((left, right) => left.package.localeCompare(right.package));
    const localPath = posix(relative(root, repositoryRoot)) || ".";
    repositories.push({
      git: patches[0]!.git,
      rev: revisions[0]!,
      localPath,
      packages,
    });
  }
  repositories.sort((left, right) => left.git.localeCompare(right.git));

  const cargoConfigPath = posix(relative(root, loaded.cargoConfigPath));
  const cargo = {
    ...(cargoConfigPath !== ".cargo/config.toml" ? { configPath: cargoConfigPath } : {}),
    ...(loaded.localOnly ? { localOnly: true } : {}),
    repositories,
  };
  return { content: `${JSON.stringify({ schemaVersion: 3, cargo }, null, 2)}\n` };
}

export function reconcileFleetSourceDependencies(
  fleetRoot: string,
  options: { apply?: boolean; run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  const root = resolve(fleetRoot);
  const runner = options.run ?? runCommand;
  const diagnostics: Diagnostic[] = [];
  const repositories = repositoryDirectories(root)
    .filter((repositoryRoot) => existsSync(join(repositoryRoot, defaultSourceDependencyConfigPath)))
    .map((repositoryRoot) => {
      const id = basename(repositoryRoot);
      try {
        const loaded = readSourceDependencyConfig(repositoryRoot);
        const graph = verifySourceDependencyGraph(repositoryRoot, undefined, { run: runner });
        const migration = migrationConfig(repositoryRoot, loaded, runner);
        if (graph.status === "failed") {
          diagnostics.push(
            ...graph.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              message: `${id}: ${diagnostic.message}`,
            })),
          );
        }
        if (migration.reason) {
          diagnostics.push({
            code: "source-reconcile-migration-blocked",
            message: `${id}: ${migration.reason}`,
            path: join(repositoryRoot, defaultSourceDependencyConfigPath),
          });
        }
        return {
          id,
          root: repositoryRoot,
          schemaVersion: loaded.schemaVersion,
          localOnly: loaded.localOnly,
          graphStatus: graph.status,
          conflicts: graph.data.conflicts ?? [],
          migrationAvailable: Boolean(migration.content),
          migrationBlocked: migration.reason ?? null,
          content: migration.content,
        };
      } catch (error) {
        diagnostics.push({
          code: "source-reconcile-config-invalid",
          message: `${id}: ${error instanceof Error ? error.message : String(error)}`,
          path: join(repositoryRoot, defaultSourceDependencyConfigPath),
        });
        return {
          id,
          root: repositoryRoot,
          schemaVersion: null,
          localOnly: null,
          graphStatus: "failed",
          conflicts: [],
          migrationAvailable: false,
          migrationBlocked: "invalid source dependency config",
          content: undefined,
        };
      }
    });

  const blocking = diagnostics.length > 0;
  const changes: Array<Record<string, unknown>> = [];
  if (options.apply && !blocking) {
    for (const repository of repositories) {
      if (!repository.content) continue;
      const path = join(repository.root, defaultSourceDependencyConfigPath);
      const reconciliation = reconcileTextFile(path, repository.content);
      changes.push({
        repository: repository.id,
        path,
        reconciliation,
        changed: reconciliationChanged(reconciliation),
      });
    }
  }

  const publicRepositories = repositories.map(({ content: _content, ...repository }) => repository);
  return {
    schemaVersion: 1,
    operation: "fleet",
    status: publicRepositories.length === 0 ? "unavailable" : blocking ? "failed" : "passed",
    durationMs: Math.round(performance.now() - started),
    data: {
      action: "source-deps-reconcile",
      root,
      apply: options.apply ?? false,
      repositories: publicRepositories,
      changes,
      changed: changes.some((change) => change.changed === true),
      notes: [
        "Schema-v3 migration preserves existing exact revisions; it never chooses a new revision.",
        "Transitive revision conflicts block apply and require compatibility evidence before reconciliation.",
        "A repeated apply is a verified no-op when every eligible repository is already on schema v3.",
      ],
    },
    diagnostics:
      publicRepositories.length === 0
        ? [
            {
              code: "source-reconcile-repositories-unavailable",
              message: `No direct child repositories with ${defaultSourceDependencyConfigPath} found under ${root}`,
            },
          ]
        : diagnostics,
  };
}
