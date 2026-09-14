import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import {
  defaultSourceDependencyConfigPath,
  readSourceDependencyConfig,
  type CargoSourceRepository,
  type LoadedSourceDependencyConfig,
} from "./source-deps.ts";
import { type CommandResult, runCommand } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type Expectation = {
  repository: string;
  git: string;
  revision: string;
  consumerRoot: string;
  localRoot: string | null;
  actualRevision: string | null;
};

function canonicalRepository(git: string): string {
  return git
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function localRepositoryRoot(
  consumerRoot: string,
  loaded: LoadedSourceDependencyConfig,
  repository: CargoSourceRepository,
  runner: Runner,
): { root: string | null; diagnostic?: Diagnostic } {
  const direct = repository.localPath ? resolve(consumerRoot, repository.localPath) : null;
  const packagePath = loaded.patches.find(
    (patch) =>
      patch.git === repository.git &&
      patch.rev.toLowerCase() === repository.rev.toLowerCase() &&
      patch.localPath,
  )?.localPath;
  const candidate = direct ?? (packagePath ? resolve(consumerRoot, packagePath) : null);
  if (!candidate) return { root: null };
  if (!existsSync(candidate)) {
    return {
      root: null,
      diagnostic: {
        code: "source-graph-local-source-missing",
        message: `Local source checkout does not exist for ${repository.git} at ${candidate}`,
        path: loaded.path,
      },
    };
  }
  const result = runner("git", ["-C", candidate, "rev-parse", "--show-toplevel"], consumerRoot);
  const root = result.status === 0 ? result.stdout.trim() : "";
  if (!root) {
    return {
      root: null,
      diagnostic: {
        code: "source-graph-local-root-unavailable",
        message: `Could not resolve repository root for ${repository.git} from ${candidate}`,
        path: loaded.path,
      },
    };
  }
  return { root: resolve(root) };
}

function actualRevision(root: string, runner: Runner): string | null {
  const result = runner("git", ["-C", root, "rev-parse", "HEAD"], root);
  const value = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}

export function verifySourceDependencyGraph(
  root: string,
  configPath?: string,
  dependencies: { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  const runner = dependencies.run ?? runCommand;
  const consumerRoot = resolve(root);
  const initialConfig = resolve(consumerRoot, configPath ?? defaultSourceDependencyConfigPath);
  if (!existsSync(initialConfig)) {
    return {
      schemaVersion: 1,
      operation: "source-deps",
      status: "unavailable",
      durationMs: Math.round(performance.now() - started),
      data: { action: "verify-graph", root: consumerRoot, configPath: initialConfig },
      diagnostics: [
        {
          code: "source-graph-config-missing",
          message: `Source dependency config does not exist: ${initialConfig}`,
          path: initialConfig,
        },
      ],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const expectations: Expectation[] = [];
  const visitedConfigs = new Set<string>();

  function visit(repositoryRoot: string, nestedConfigPath?: string): void {
    const absoluteConfigPath = resolve(
      repositoryRoot,
      nestedConfigPath ?? defaultSourceDependencyConfigPath,
    );
    if (visitedConfigs.has(absoluteConfigPath)) return;
    visitedConfigs.add(absoluteConfigPath);

    let loaded: LoadedSourceDependencyConfig;
    try {
      loaded = readSourceDependencyConfig(repositoryRoot, nestedConfigPath);
    } catch (error) {
      diagnostics.push({
        code: "source-graph-config-invalid",
        message: `${absoluteConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
        path: absoluteConfigPath,
      });
      return;
    }

    for (const repository of loaded.repositories) {
      const local = localRepositoryRoot(repositoryRoot, loaded, repository, runner);
      if (local.diagnostic) diagnostics.push(local.diagnostic);
      if (loaded.localOnly && !local.root && !local.diagnostic) {
        diagnostics.push({
          code: "source-graph-local-source-required",
          message: `${repository.git} is local-only but no local source checkout can be resolved`,
          path: loaded.path,
        });
      }
      const actual = local.root ? actualRevision(local.root, runner) : null;
      if (local.root && actual === null) {
        diagnostics.push({
          code: "source-graph-revision-unavailable",
          message: `Could not read local source revision for ${repository.git} at ${local.root}`,
          path: loaded.path,
        });
      } else if (actual && actual !== repository.rev.toLowerCase()) {
        diagnostics.push({
          code: "source-graph-revision-drift",
          message: `${repository.git} local source is ${actual}, expected ${repository.rev.toLowerCase()}`,
          path: loaded.path,
        });
      }

      expectations.push({
        repository: canonicalRepository(repository.git),
        git: repository.git,
        revision: repository.rev.toLowerCase(),
        consumerRoot: repositoryRoot,
        localRoot: local.root,
        actualRevision: actual,
      });

      if (local.root) {
        const transitiveConfig = join(local.root, defaultSourceDependencyConfigPath);
        if (existsSync(transitiveConfig)) visit(local.root);
      }
    }
  }

  visit(consumerRoot, configPath);

  const byRepository = new Map<string, Expectation[]>();
  for (const expectation of expectations) {
    const current = byRepository.get(expectation.repository) ?? [];
    current.push(expectation);
    byRepository.set(expectation.repository, current);
  }

  const conflicts = [...byRepository.entries()]
    .map(([repository, entries]) => {
      const revisions = [...new Set(entries.map((entry) => entry.revision))].sort();
      return {
        repository,
        revisions,
        consumers: [...new Set(entries.map((entry) => entry.consumerRoot))].sort(),
      };
    })
    .filter((entry) => entry.revisions.length > 1)
    .sort((left, right) => left.repository.localeCompare(right.repository));
  for (const conflict of conflicts) {
    diagnostics.push({
      code: "source-graph-revision-conflict",
      message: `${conflict.repository} is required at conflicting revisions ${conflict.revisions.join(", ")} by ${conflict.consumers.join(", ")}`,
      path: initialConfig,
    });
  }

  const repositories = [...byRepository.entries()]
    .map(([repository, entries]) => ({
      repository,
      git: [...new Set(entries.map((entry) => entry.git))].sort()[0] ?? repository,
      declaredRevisions: [...new Set(entries.map((entry) => entry.revision))].sort(),
      actualRevisions: [
        ...new Set(
          entries
            .map((entry) => entry.actualRevision)
            .filter((revision): revision is string => revision !== null),
        ),
      ].sort(),
      localRoots: [
        ...new Set(
          entries
            .map((entry) => entry.localRoot)
            .filter((value): value is string => value !== null),
        ),
      ].sort(),
      consumers: [...new Set(entries.map((entry) => entry.consumerRoot))].sort(),
    }))
    .sort((left, right) => left.repository.localeCompare(right.repository));

  return {
    schemaVersion: 1,
    operation: "source-deps",
    status: diagnostics.length === 0 ? "passed" : "failed",
    durationMs: Math.round(performance.now() - started),
    data: {
      action: "verify-graph",
      root: consumerRoot,
      configPath: initialConfig,
      repositories,
      conflicts,
      visitedConfigs: [...visitedConfigs].sort(),
    },
    diagnostics,
  };
}
