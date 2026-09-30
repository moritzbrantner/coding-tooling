import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { fleetAuthorityGraph, parseAuthorityBoundaries } from "./fleet-authority-graph.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import {
  forbiddenAuthorityClaims,
  type RepositoryLifecycleCommand,
} from "./repository-contract-declarations.ts";
import { readRepositoryMetadata, type RepositoryMetadata } from "./repository-metadata.ts";
import type { CommandResult } from "./shared.ts";
import { defaultSourceDependencyConfigPath } from "./source-deps.ts";
import { verifySourceDependencyGraph } from "./source-graph.ts";

type ContractRunner = (argv: string[], cwd: string, timeoutSeconds: number) => CommandResult;
type CommandObservation = {
  phase: "command" | "check";
  argv: string[];
  exitCode: number;
  signal: string | null;
  error: string | null;
};
type LifecycleResult = {
  status:
    | "missing"
    | "not-run"
    | "not-applicable"
    | "blocked"
    | "passed"
    | "failed"
    | "unavailable";
  commands: CommandObservation[];
  reason?: string;
};

type RepositoryContractData = {
  schemaVersion: "coding-tooling/repository-contract/v1";
  root: string;
  id: string | null;
  purpose: string | null;
  declarations: RepositoryMetadata | null;
  missingDeclarations: string[];
  bootstrap: LifecycleResult;
  pages: LifecycleResult;
  sourceDependencies: ResultEnvelope<Record<string, unknown>> | null;
  provenance: {
    revision: string | null;
    checkoutRoot: string | null;
    checkoutRemoved: boolean;
    executionRequested: boolean;
    runtime: string;
    platform: string;
    arch: string;
  };
  limitations: string[];
};

function sourceRequirements(report: ResultEnvelope<Record<string, unknown>> | null): Array<{
  repository: string;
  revisions: string[];
  localRoots: string[];
}> {
  const repositories: unknown[] = Array.isArray(report?.data.repositories)
    ? report.data.repositories
    : [];
  return repositories.flatMap((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      !("repository" in value) ||
      typeof value.repository !== "string"
    )
      return [];
    const revisions =
      "declaredRevisions" in value && Array.isArray(value.declaredRevisions)
        ? value.declaredRevisions.filter((entry): entry is string => typeof entry === "string")
        : [];
    const localRoots =
      "localRoots" in value && Array.isArray(value.localRoots)
        ? value.localRoots.filter((entry): entry is string => typeof entry === "string")
        : [];
    return [{ repository: value.repository, revisions, localRoots }];
  });
}

export function repositoryCommandEnvironment(
  environment: NodeJS.ProcessEnv,
  windows = process.platform === "win32",
): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (!windows) return result;
  const keys = Object.keys(result).filter((key) => key.toLowerCase() === "path");
  let pathKey = keys[0] ?? "PATH";
  for (const key of keys) if (key < pathKey) pathKey = key;
  const path = result[pathKey];
  for (const key of keys) delete result[key];
  result.PATH = path;
  return result;
}

function nativeRunner(sourceRoot: string): ContractRunner {
  const fleetRoot = dirname(resolve(sourceRoot));
  const env = repositoryCommandEnvironment(process.env);
  env.PATH = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => {
      if (!isAbsolute(entry)) return false;
      const path = relative(fleetRoot, entry);
      if (
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      )
        return true;
      const repository = join(fleetRoot, path.split(/[\\/]/)[0]!);
      return repository !== sourceRoot && !existsSync(join(repository, ".git"));
    })
    .join(delimiter);
  return (argv, cwd, timeoutSeconds) => {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd,
      env,
      shell: false,
      encoding: "utf8",
      timeout: timeoutSeconds * 1000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      command: argv,
      status: result.status ?? 127,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      signal: result.signal ?? undefined,
      error: result.error?.message,
    };
  };
}

function resultStatus(
  diagnostics: Diagnostic[],
  missing: string[],
  bootstrap: LifecycleResult,
  pages: LifecycleResult,
): ResultStatus {
  if (diagnostics.length > 0 || bootstrap.status === "failed" || pages.status === "failed")
    return "failed";
  if (
    missing.length > 0 ||
    bootstrap.status === "unavailable" ||
    pages.status === "unavailable" ||
    pages.status === "blocked"
  )
    return "unavailable";
  return "passed";
}

export function repositoryContractCommand(
  root: string,
  options: { execute?: boolean; run?: ContractRunner } = {},
): ResultEnvelope<RepositoryContractData> {
  const started = Date.now();
  const sourceRoot = resolve(root);
  const runner = options.run ?? nativeRunner(sourceRoot);
  const diagnostics: Diagnostic[] = [];
  let metadata: RepositoryMetadata | undefined;
  try {
    const read = readRepositoryMetadata(sourceRoot);
    metadata = read.metadata;
    diagnostics.push(...read.diagnostics);
  } catch (error) {
    diagnostics.push({ code: "repository-contract-read-failed", message: String(error) });
  }

  const missing = [
    ...(!metadata?.summary?.trim() ? ["purpose"] : []),
    ...(!metadata?.architecture ? ["architecture"] : []),
    ...(!metadata?.bootstrap ? ["bootstrap"] : []),
    ...(!metadata?.pages ? ["pages"] : []),
  ];
  if (metadata?.architecture) {
    const agentsPath = join(sourceRoot, "AGENTS.md");
    let authority;
    try {
      authority = existsSync(agentsPath)
        ? parseAuthorityBoundaries(readFileSync(agentsPath, "utf8"))
        : undefined;
    } catch (error) {
      diagnostics.push({
        code: "repository-authority-read-failed",
        message: String(error),
        path: "AGENTS.md",
      });
    }
    for (const violation of forbiddenAuthorityClaims(
      {
        ...metadata.architecture,
        mustNotOwn: [...metadata.architecture.mustNotOwn, ...(authority?.nonAuthoritative ?? [])],
      },
      metadata.architecture.owns,
    )) {
      diagnostics.push({
        code: "repository-forbidden-authority",
        message: `${violation.capability} violates must_not_own ${violation.exclusion}`,
        path: ".repository.toml",
      });
    }
    if (
      authority &&
      JSON.stringify(authority.owns) !== JSON.stringify(metadata.architecture.owns)
    ) {
      diagnostics.push({
        code: "repository-authority-declaration-drift",
        message: ".repository.toml architecture.owns disagrees with AGENTS.md Owns",
        path: ".repository.toml",
      });
    }
  }

  let bootstrap: LifecycleResult = {
    status: metadata?.bootstrap ? "not-run" : "missing",
    commands: [],
  };
  let pages: LifecycleResult =
    metadata?.pages?.status === "not-applicable"
      ? { status: "not-applicable", reason: metadata.pages.reason, commands: [] }
      : { status: metadata?.pages ? "not-run" : "missing", commands: [] };
  let revision: string | null = null;
  let sourceDependencies: ResultEnvelope<Record<string, unknown>> | null = null;
  if (existsSync(join(sourceRoot, defaultSourceDependencyConfigPath))) {
    sourceDependencies = verifySourceDependencyGraph(sourceRoot, undefined, {
      run: (command, args = [], cwd = sourceRoot) => runner([command, ...args], cwd, 30),
    });
  }
  let checkoutRoot: string | null = null;

  function runLifecycle(
    declaration: RepositoryLifecycleCommand,
    checkout: string,
  ): LifecycleResult {
    const commands: CommandObservation[] = [];
    for (const phase of ["command", "check"] as const) {
      const argv = declaration[phase];
      const result = runner(argv, checkout, declaration.timeoutSeconds);
      commands.push({
        phase,
        argv,
        exitCode: result.status,
        signal: result.signal ?? null,
        error: result.error ?? null,
      });
      if (result.status !== 0) {
        return { status: result.error || result.signal ? "unavailable" : "failed", commands };
      }
      const head = runner(["git", "rev-parse", "HEAD"], checkout, 30);
      if (head.status !== 0)
        return { status: "unavailable", commands, reason: "Could not inspect checkout revision" };
      if (head.stdout.trim().toLowerCase() !== revision)
        return {
          status: "failed",
          commands,
          reason: `${phase} changed the captured source revision`,
        };
      const state = runner(["git", "status", "--porcelain", "--untracked-files=all"], checkout, 30);
      if (state.status !== 0)
        return { status: "unavailable", commands, reason: "Could not inspect checkout mutations" };
      if (state.stdout.trim()) {
        return {
          status: "failed",
          commands,
          reason: `${phase} changed committed source or added unignored files`,
        };
      }
    }
    return { status: "passed", commands };
  }

  if (options.execute && metadata?.bootstrap && diagnostics.length === 0 && missing.length === 0) {
    const state = runner(["git", "status", "--porcelain", "--untracked-files=all"], sourceRoot, 30);
    const head = runner(["git", "rev-parse", "HEAD"], sourceRoot, 30);
    if (
      state.status !== 0 ||
      state.stdout.trim() ||
      head.status !== 0 ||
      !/^[a-f0-9]{40}$/i.test(head.stdout.trim())
    ) {
      bootstrap = {
        status: "unavailable",
        commands: [],
        reason: "Fresh-checkout verification requires a clean committed source revision",
      };
    } else {
      revision = head.stdout.trim().toLowerCase();
      const temporary = mkdtempSync(join(tmpdir(), "coding-tooling-repository-contract-"));
      checkoutRoot = join(temporary, "repository");
      try {
        const clone = runner(
          [
            "git",
            "clone",
            "--quiet",
            "--no-local",
            "--no-checkout",
            "--",
            sourceRoot,
            checkoutRoot,
          ],
          temporary,
          30,
        );
        const checkout =
          clone.status === 0
            ? runner(["git", "checkout", "--quiet", "--detach", revision], checkoutRoot, 30)
            : clone;
        if (checkout.status !== 0) {
          bootstrap = {
            status: "unavailable",
            commands: [],
            reason: "Could not create the exact clean checkout",
          };
        } else {
          bootstrap = runLifecycle(metadata.bootstrap, checkoutRoot);
          if (
            bootstrap.status === "passed" &&
            existsSync(join(checkoutRoot, defaultSourceDependencyConfigPath))
          ) {
            sourceDependencies = verifySourceDependencyGraph(checkoutRoot, undefined, {
              run: (command, args = [], cwd = checkoutRoot!) => runner([command, ...args], cwd, 30),
            });
            const outside = sourceRequirements(sourceDependencies)
              .flatMap((requirement) => requirement.localRoots)
              .filter((path) => {
                const child = relative(temporary, path);
                return (
                  isAbsolute(child) ||
                  child === ".." ||
                  child.startsWith("../") ||
                  child.startsWith("..\\")
                );
              });
            if (outside.length > 0) {
              sourceDependencies = {
                ...sourceDependencies,
                status: "failed",
                diagnostics: [
                  ...sourceDependencies.diagnostics,
                  {
                    code: "bootstrap-external-source-checkout",
                    message: `Clean bootstrap borrowed source outside the isolated workspace: ${outside.join(", ")}`,
                  },
                ],
              };
            }
            if (sourceDependencies.status !== "passed") {
              bootstrap = {
                ...bootstrap,
                status: "failed",
                reason: "Exact source-dependency verification did not pass in the clean checkout",
              };
            }
          }
          if (bootstrap.status === "passed" && metadata.pages?.status === "enabled") {
            pages = runLifecycle(metadata.pages, checkoutRoot);
          }
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
  if (options.execute && metadata?.pages?.status === "enabled" && bootstrap.status !== "passed") {
    pages = {
      status: "blocked",
      commands: [],
      reason: "Bootstrap did not pass in a clean checkout",
    };
  }
  if (sourceDependencies && sourceDependencies.status !== "passed")
    diagnostics.push(...sourceDependencies.diagnostics);

  return {
    schemaVersion: 1,
    operation: "repository-contract",
    status: resultStatus(diagnostics, missing, bootstrap, pages),
    durationMs: Date.now() - started,
    data: {
      schemaVersion: "coding-tooling/repository-contract/v1",
      root: sourceRoot,
      id: metadata?.id ?? null,
      purpose: metadata?.summary ?? null,
      declarations: metadata ?? null,
      missingDeclarations: missing,
      bootstrap,
      pages,
      sourceDependencies,
      provenance: {
        revision,
        checkoutRoot,
        checkoutRemoved: checkoutRoot !== null,
        executionRequested: options.execute === true,
        runtime: `bun@${Bun.version}`,
        platform: process.platform,
        arch: process.arch,
      },
      limitations: [
        "Working-directory isolation is not a filesystem or network sandbox.",
        "Ownership is declared metadata; this check does not infer architectural semantics from source.",
      ],
    },
    diagnostics,
  };
}

export function fleetRepositoryContracts(
  root: string,
  options: { execute?: boolean; run?: ContractRunner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const graph = fleetAuthorityGraph(root);
  const entries: unknown[] = Array.isArray(graph.data.repositories) ? graph.data.repositories : [];
  const reports = entries.flatMap((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("root" in entry) ||
      typeof entry.root !== "string"
    )
      return [];
    return [repositoryContractCommand(entry.root, options)];
  });
  const owners = new Map<string, Set<string>>();
  function own(capability: string, id: string): void {
    const current = owners.get(capability) ?? new Set<string>();
    current.add(id);
    owners.set(capability, current);
  }
  const graphOwners = graph.data.authorityOwners;
  if (graphOwners && typeof graphOwners === "object") {
    for (const [capability, ids] of Object.entries(graphOwners)) {
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") own(capability, id);
    }
  }
  for (const report of reports) {
    const metadata = report.data.declarations;
    if (metadata)
      for (const capability of metadata.architecture?.owns ?? []) own(capability, metadata.id);
  }
  const ownershipConflicts = [...owners.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([capability, ids]) => ({
      capability,
      // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array under the ES2022 target.
      repositories: [...ids].sort(),
    }))
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh result array under the ES2022 target.
    .sort((a, b) => a.capability.localeCompare(b.capability));
  const revisionsByRepository = new Map<string, Set<string>>();
  for (const report of reports) {
    for (const requirement of sourceRequirements(report.data.sourceDependencies)) {
      const current = revisionsByRepository.get(requirement.repository) ?? new Set<string>();
      for (const revision of requirement.revisions) current.add(revision);
      revisionsByRepository.set(requirement.repository, current);
    }
  }
  const sourceRevisionConflicts = [...revisionsByRepository.entries()]
    .filter(([, revisions]) => revisions.size > 1)
    .map(([repository, revisions]) => ({
      repository,
      // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh revision evidence under the ES2022 target.
      revisions: [...revisions].sort(),
    }))
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh result array under the ES2022 target.
    .sort((a, b) => a.repository.localeCompare(b.repository));
  const diagnostics = [...graph.diagnostics, ...reports.flatMap((report) => report.diagnostics)];
  for (const conflict of ownershipConflicts)
    diagnostics.push({
      code: "fleet-competing-authority-owners",
      message: `${conflict.capability}: ${conflict.repositories.join(", ")}`,
    });
  for (const conflict of sourceRevisionConflicts)
    diagnostics.push({
      code: "fleet-source-revision-conflict",
      message: `${conflict.repository}: ${conflict.revisions.join(", ")}`,
    });
  const status: ResultStatus =
    ownershipConflicts.length ||
    sourceRevisionConflicts.length ||
    reports.some((report) => report.status === "failed")
      ? "failed"
      : !reports.length || reports.some((report) => report.status !== "passed")
        ? "unavailable"
        : "passed";
  return {
    schemaVersion: 1,
    operation: "fleet-repository-contracts",
    status,
    durationMs: Date.now() - started,
    data: {
      schemaVersion: "coding-tooling/fleet-repository-contracts/v1",
      root: resolve(root),
      repositories: reports,
      dependencyEdges: graph.data.dependencyEdges ?? [],
      ownershipConflicts,
      sourceRevisionConflicts,
      missingDeclarations: reports
        .filter(
          (report) =>
            Array.isArray(report.data.missingDeclarations) &&
            report.data.missingDeclarations.length,
        )
        .map((report) => ({ id: report.data.id, declarations: report.data.missingDeclarations })),
      bootstrapFailures: reports
        .filter((report) => report.data.bootstrap.status === "failed")
        .map((report) => report.data.id),
      pagesFailures: reports
        .filter((report) => report.data.pages.status === "failed")
        .map((report) => report.data.id),
    },
    diagnostics,
  };
}
