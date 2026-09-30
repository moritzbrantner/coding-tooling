import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveConventions } from "./conventions.ts";
import { conventionModuleReferences } from "./convention-registry.ts";
import { declaredComponents, loadConfig } from "./core.ts";
import { generatorCatalog } from "./generators.ts";
import { defaultTiers, type Diagnostic, type ResultEnvelope } from "./model.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { defaultSourceDependencyConfigPath, readSourceDependencyConfig } from "./source-deps.ts";
import { relativePosix, walkFiles } from "./shared.ts";
import { containedTaskPath, selectTaskScope } from "./task-scope-selection.ts";

export type TaskInspectionOptions = {
  targets?: string[];
  components?: string[];
  taskKind?: string;
  configPath?: string;
  policyContext?: ResultEnvelope<Record<string, unknown>>;
  policyContextPath?: string;
  conventionsRoot?: string;
  registryPath?: string;
};

function strings(values: string[]): string[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh pointer list under ES2022.
  return [...new Set(values)].sort();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ordered<T>(values: readonly T[], key: (value: T) => string): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh copy under ES2022.
  return [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function inspectTaskContext(
  root: string,
  options: TaskInspectionOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const resolved = resolve(root);
  const diagnostics: Diagnostic[] = [];
  function gap(code: string, message: string, path?: string): void {
    diagnostics.push({ code, message, ...(path ? { path } : {}) });
  }
  function pointer(path: string, kind: string) {
    const available = containedTaskPath(resolved, path);
    if (!available)
      gap(
        "task-reference-unresolved",
        `${kind} pointer is missing or outside the repository: ${path}`,
        path,
      );
    return { path, kind, status: available ? "available" : "unavailable" };
  }
  try {
    const configPath = options.configPath ?? ".coding-tooling.json";
    const config = loadConfig(resolved, configPath);
    const components = ordered(
      declaredComponents(resolved, config),
      (component) => `${component.path}\0${component.kind}\0${component.name}`,
    );
    const knowledge = config.taskKnowledge;
    const selection = selectTaskScope(resolved, options, components, knowledge, diagnostics);
    const instructionPaths = new Set<string>();
    function ancestorInstructions(directory: string): void {
      let current = directory;
      while (true) {
        for (const name of ["AGENTS.md", "CLAUDE.md"]) {
          const path = join(current, name);
          const entry = lstatSync(path, { throwIfNoEntry: false });
          if (entry?.isFile() || entry?.isSymbolicLink()) {
            instructionPaths.add(path);
            if (!statSync(path, { throwIfNoEntry: false })?.isFile())
              gap(
                "task-ancestor-instruction-unavailable",
                `Applicable instruction pointer cannot be read as a regular file: ${path}`,
                path,
              );
          }
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    ancestorInstructions(resolved);
    for (const target of selection.targets) {
      ancestorInstructions(
        target.directory ? resolve(resolved, target.path) : dirname(resolve(resolved, target.path)),
      );
    }
    const directoryTargets = selection.conservative
      ? [resolved]
      : selection.targets
          .filter((target) => target.directory)
          .map((target) => resolve(resolved, target.path));
    for (const directory of directoryTargets) {
      for (const path of walkFiles(directory, 16, {
        onTruncatedDirectory: (path) =>
          gap(
            "task-instruction-discovery-bounded",
            `Directory instruction discovery reached its depth bound at ${relativePosix(resolved, path)}`,
            relativePosix(resolved, path),
          ),
      })) {
        if (/\/(?:AGENTS|CLAUDE)\.md$/.test(path.replaceAll("\\", "/"))) instructionPaths.add(path);
      }
    }
    const declaredInstructions = strings([
      ...(knowledge?.alwaysInstructions ?? []),
      ...selection.scopes.flatMap((scope) => scope.instructions ?? []),
    ]).map((path) => pointer(path, "declared-instruction"));
    const requestedGenerators = strings(
      selection.scopes.flatMap((scope) => scope.generators ?? []),
    );
    let catalog: ReturnType<typeof generatorCatalog> = [];
    if (requestedGenerators.length) {
      try {
        catalog = generatorCatalog(resolved).filter((generator) =>
          requestedGenerators.includes(generator.id),
        );
      } catch (error) {
        gap(
          "task-generator-catalog-unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const policy =
      options.policyContext ??
      (options.policyContextPath
        ? readTaskPolicyContext(resolve(resolved, options.policyContextPath))
        : resolveConventions({
            root: resolved,
            configPath: options.configPath,
            conventionsRoot: options.conventionsRoot,
            registryPath: options.registryPath,
          }));
    const policyData = policy.data;
    const policyIdentity =
      policy.operation === "conventions" &&
      typeof policyData.root === "string" &&
      resolve(policyData.root) === resolved &&
      typeof policyData.sourceRoot === "string" &&
      typeof policyData.sourceRevision === "string" &&
      record(policyData.ruleSources);
    if (!policyIdentity)
      gap(
        "task-policy-context-unsupported",
        "Policy context must be a convention-resolution envelope for this repository with ruleSources and source provenance",
      );
    if (policy.status !== "passed") diagnostics.push(...policy.diagnostics);
    if (policy.status !== "passed" && !policy.diagnostics.length)
      gap("task-policy-context-unavailable", "Convention resolution did not pass");
    const ruleSources =
      policyIdentity && record(policyData.ruleSources) ? policyData.ruleSources : {};
    const alwaysRules = Object.entries(ruleSources)
      .filter(
        ([, path]) =>
          typeof path === "string" &&
          /^(?:principles\/|conventions\/(?:agents|security)\/)/.test(path),
      )
      .map(([id]) => id);
    const selectedRules = strings([
      ...alwaysRules,
      ...(config.conventionRefs ?? []),
      ...selection.scopes.flatMap((scope) => scope.conventionRefs ?? []),
      ...(knowledge?.exceptions ?? []).map((exception) => exception.ruleId),
      ...catalog.flatMap((generator) => generator.rules),
    ]);
    const conventions = selectedRules.map((id) => {
      const path = ruleSources[id];
      if (typeof path !== "string") {
        gap("task-convention-reference-unresolved", `Unknown stable convention reference: ${id}`);
        return { id, status: "unavailable", path: null };
      }
      const sourceRoot = typeof policyData.sourceRoot === "string" ? policyData.sourceRoot : "";
      const available = containedTaskPath(sourceRoot, path);
      if (!available)
        gap(
          "task-convention-source-unavailable",
          `Convention source is missing or outside its declared root: ${id}`,
          path,
        );
      return {
        id,
        path,
        absolutePath: resolve(sourceRoot, path),
        sourceRevision: policyData.sourceRevision,
        status: available ? "available" : "unavailable",
      };
    });
    let conventionModules: ReturnType<typeof conventionModuleReferences> = [];
    if (policyIdentity && typeof policyData.sourceRoot === "string") {
      try {
        conventionModules = conventionModuleReferences(
          policyData.sourceRoot,
          conventions.flatMap((reference) =>
            typeof reference.path === "string" ? [reference.path] : [],
          ),
        );
      } catch (error) {
        gap(
          "task-convention-modules-unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const exceptions = ordered(
      knowledge?.exceptions ?? [],
      (exception) => `${exception.ruleId}\0${exception.source}`,
    ).map((exception) => ({
      ...exception,
      source: pointer(exception.source, "explicit-exception"),
      ruleStatus: typeof ruleSources[exception.ruleId] === "string" ? "declared" : "unresolved",
      semantics: "explicit-reference-only",
    }));
    const examples = ordered(
      selection.scopes.flatMap((scope) =>
        (scope.examples ?? []).map((example) => ({
          ...pointer(example.path, "canonical-example"),
          entrypoint: example.entrypoint ?? null,
          declaredBy: scope.id,
          execution: "not-run",
        })),
      ),
      (example) => `${example.path}\0${example.entrypoint ?? ""}\0${example.declaredBy}`,
    );
    const generators = requestedGenerators.map((id) => {
      const generator = catalog.find((entry) => entry.id === id);
      if (!generator) gap("task-generator-unresolved", `Existing generator is unavailable: ${id}`);
      return {
        id,
        status: generator ? "available" : "unavailable",
        path: generator?.path ?? null,
        module: generator?.module ?? null,
        source: generator?.source ?? null,
        rules: generator?.rules ?? [],
        command: ["coding-tooling", "generate", "describe", id, "--json"],
      };
    });
    const metadata = existsSync(join(resolved, ".repository.toml"))
      ? readRepositoryMetadata(resolved)
      : undefined;
    if (metadata && !metadata.metadata) diagnostics.push(...metadata.diagnostics);
    const sourceDependencies = ordered(
      existsSync(join(resolved, defaultSourceDependencyConfigPath))
        ? readSourceDependencyConfig(resolved).sourceRepositories.map((repository) => ({
            git: repository.git,
            revision: repository.rev,
            ecosystem: repository.ecosystem,
            localPath: repository.localPath ?? null,
            verification: "not-run",
          }))
        : [],
      (repository) =>
        `${repository.git}\0${repository.revision}\0${repository.ecosystem}\0${repository.localPath ?? ""}`,
    );
    const owners = strings(selection.scopes.flatMap((scope) => scope.owners ?? [])).map((id) => ({
      id,
      source: configPath,
      validation:
        id === metadata?.metadata?.id
          ? "repository-completion-gate"
          : "external-validation-not-selected",
    }));
    const focusedCapabilities = new Set<string>(
      selection.scopes.flatMap((scope) => scope.capabilities ?? []),
    );
    const focusedCommands = ordered(
      selection.components.flatMap((component) =>
        Object.entries(component.capabilities)
          .filter(
            ([capability]) =>
              selection.conservative ||
              !focusedCapabilities.size ||
              focusedCapabilities.has(capability),
          )
          .map(([capability, command]) => ({
            component: component.name,
            path: component.path,
            capability,
            command,
            execution: "not-run",
          })),
      ),
      (command) =>
        `${command.path}\0${command.component}\0${command.capability}\0${JSON.stringify(command.command)}`,
    );
    for (const capability of focusedCapabilities) {
      if (!focusedCommands.some((command) => command.capability === capability))
        gap(
          "task-focused-capability-unavailable",
          `Declared focused capability is unavailable: ${capability}`,
        );
    }
    const completion = knowledge?.completion;
    let completionGate;
    if (completion && "command" in completion) {
      completionGate = {
        kind: "command",
        command: completion.command,
        source: pointer(completion.source, "completion-declaration"),
        execution: "not-run",
      };
    } else {
      const tier = completion?.tier ?? "full";
      const selected = config.tiers?.[tier] ?? defaultTiers[tier];
      if (!selected)
        gap("task-completion-tier-unresolved", `Completion tier does not exist: ${tier}`);
      if (!completion)
        gap(
          "task-completion-gate-undeclared",
          "No explicit completion declaration; retain the conservative full-tier pointer",
        );
      completionGate = {
        kind: "tier",
        tier,
        command: ["coding-tooling", "run", "--tier", tier, "--json"],
        capabilities: selected ?? null,
        source: configPath,
        selection: completion ? "declared" : "conservative-fallback",
        execution: "not-run",
      };
    }
    if (!focusedCommands.length)
      gap(
        "task-focused-commands-unavailable",
        "No declared commands cover the selected scope; completion gate remains visible",
      );
    const stableInstructions = strings(
      [...instructionPaths].map((path) => relativePosix(resolved, path)),
    );
    return {
      schemaVersion: 1,
      operation: "inspect",
      status: diagnostics.length ? "unavailable" : "passed",
      durationMs: Date.now() - started,
      data: {
        root: resolved,
        technologies: strings(components.flatMap((component) => component.technologies)),
        components,
        taskContext: {
          schemaVersion: "coding-tooling/task-context/v1",
          status: diagnostics.length ? "partial" : "resolved",
          selection: {
            targets: selection.targets,
            components: selection.components.map((component) => ({
              name: component.name,
              path: component.path,
            })),
            taskKind: options.taskKind ?? null,
            scopes: selection.scopes.map((scope) => scope.id),
            conservative: selection.conservative,
          },
          boundaries: {
            instructions: stableInstructions,
            metadata: metadata?.metadata ?? null,
            metadataSource: metadata ? ".repository.toml" : null,
          },
          instructions: declaredInstructions,
          conventions,
          conventionModules,
          policy: {
            sourceRoot: policyData.sourceRoot ?? null,
            sourceRevision: policyData.sourceRevision ?? null,
            reused: options.policyContext !== undefined || options.policyContextPath !== undefined,
            precedence: policyData.precedence ?? [],
            resolutionStatus: policy.status,
            contextSupported: policyIdentity,
          },
          exceptions,
          focusedCommands,
          completionGate,
          examples,
          generators,
          owners,
          sourceDependencies,
          limitations: [
            "Declared relationships and file pointers only; no example, command or generator was executed.",
            "External dependency effects and semantic ownership are not inferred from file proximity.",
            "Directory instruction discovery follows the existing ignored-directory boundary with a depth bound of 16.",
            "Explicit exceptions are referenced without interpreting arbitrary prose.",
          ],
        },
      },
      diagnostics: ordered(
        diagnostics,
        (diagnostic) => `${diagnostic.code ?? ""}\0${diagnostic.path ?? ""}\0${diagnostic.message}`,
      ),
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "inspect",
      status: "error",
      durationMs: Date.now() - started,
      data: {
        root: resolved,
        taskContext: null,
      },
      diagnostics: [
        {
          code: "task-context-invalid",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export function readTaskPolicyContext(path: string): ResultEnvelope<Record<string, unknown>> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.operation !== "conventions" ||
    !record(value.data) ||
    !Array.isArray(value.diagnostics) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    (value.status !== "passed" &&
      value.status !== "failed" &&
      value.status !== "unavailable" &&
      value.status !== "error")
  )
    throw new Error("Unsupported resolved policy context envelope");
  const diagnostics = value.diagnostics.map((diagnostic): Diagnostic => {
    if (
      !record(diagnostic) ||
      typeof diagnostic.message !== "string" ||
      (diagnostic.code !== undefined && typeof diagnostic.code !== "string") ||
      (diagnostic.path !== undefined && typeof diagnostic.path !== "string")
    )
      throw new Error("Unsupported resolved policy diagnostics");
    return {
      message: diagnostic.message,
      ...(typeof diagnostic.code === "string" ? { code: diagnostic.code } : {}),
      ...(typeof diagnostic.path === "string" ? { path: diagnostic.path } : {}),
    };
  });
  return {
    schemaVersion: 1,
    operation: "conventions",
    status: value.status,
    durationMs: value.durationMs,
    data: value.data,
    diagnostics,
  };
}
