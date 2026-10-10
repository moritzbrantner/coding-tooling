import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import { Glob, TOML } from "bun";

import { applyConventionConfigurations } from "./convention-config.ts";
import { validateConvergenceRuleConfig } from "./convergence-rule-policy.ts";
import { conventionRequiredCapabilities, runConventionChecks } from "./convention-enforcement.ts";
import {
  capabilities,
  defaultTiers,
  type Capability,
  type Component,
  type Diagnostic,
  type PlannedCheck,
  type ResultEnvelope,
  type ResultStatus,
  type ToolingConfig,
} from "./model.ts";
import {
  commandAvailable,
  readJson,
  relativePosix,
  repositoryRoot,
  runCommand,
  walkFiles,
} from "./shared.ts";
import { collectTestDiscoveryEvidence, reconcileTestScope } from "./test-discovery-evidence.ts";
import { collectTestExecutionEvidence } from "./test-execution-evidence.ts";
import { validateTaskKnowledge } from "./task-knowledge-declarations.ts";

type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type DependencyResolution = "distribution" | "source-development";

const scriptCandidates: Record<Capability, string[]> = {
  "format:check": ["format:check", "check:format"],
  lint: ["lint"],
  typecheck: ["typecheck", "check-types"],
  build: ["build"],
  test: ["test"],
  "test:unit": ["test:unit", "test"],
  "test:integration": ["test:integration"],
  "test:integration:workflow": ["test:integration:workflow"],
  "test:e2e": ["test:e2e"],
  "test:e2e:smoke": ["test:e2e:smoke"],
  "test:accessibility": ["test:accessibility"],
  "test:visual": ["test:visual"],
  "package:check": ["package:check"],
  "dependencies:audit": ["dependencies:audit", "audit:dependencies"],
  benchmark: ["benchmark", "bench"],
  "benchmark:smoke": ["benchmark:smoke", "bench:smoke"],
  "profile:runtime": ["profile:runtime"],
  "profile:hotspots": ["profile:hotspots"],
  "profile:memory": ["profile:memory"],
  "load:smoke": ["load:smoke"],
  "size:budget": ["size:budget"],
  "performance:work": ["performance:work"],
  "storybook:check": ["storybook:check"],
  "web:audit": ["web:audit"],
  "template:smoke": ["template:smoke"],
};

export function loadConfig(root: string, configuredPath = ".coding-tooling.json"): ToolingConfig {
  const path = join(root, configuredPath);
  if (!existsSync(path)) return { schemaVersion: 1 };
  const value = readJson<ToolingConfig>(path);
  if (!value || value.schemaVersion !== 1)
    throw new Error(`${configuredPath} must use schemaVersion 1`);
  validateConvergenceRuleConfig(value, configuredPath);
  validateTaskKnowledge(value.taskKnowledge);
  for (const values of Object.values(value.tiers ?? {})) validateCapabilities(values);
  validateCapabilities(value.requiredCapabilities ?? []);
  validateCapabilities(value.optionalCapabilities ?? []);
  const requiredCapabilities = new Set(value.requiredCapabilities ?? []);
  for (const capability of value.optionalCapabilities ?? []) {
    if (requiredCapabilities.has(capability))
      throw new Error(`${capability} cannot be both required and optional`);
  }
  for (const [selector, commands] of Object.entries(value.capabilityCommands ?? {})) {
    if (!selector.trim()) throw new Error("capabilityCommands selectors must not be empty");
    for (const [capability, command] of Object.entries(commands)) {
      validateCapabilities([capability]);
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        command.some((part) => typeof part !== "string" || !part)
      )
        throw new Error(
          `capabilityCommands.${selector}.${capability} must be a non-empty argv array`,
        );
    }
  }
  return value;
}

function validateCapabilities(values: readonly string[]): void {
  for (const value of values) {
    if (!capabilities.includes(value as Capability))
      throw new Error(`Unknown capability: ${value}`);
  }
}

export function discoverComponents(root = repositoryRoot(), config?: ToolingConfig): Component[] {
  const files = walkFiles(root, 4).filter((path) =>
    lstatSync(path, { throwIfNoEntry: false })?.isFile(),
  );
  const components: Component[] = [];

  for (const file of files.filter((path) => basename(path) === "package.json")) {
    const manifest = readJson<PackageManifest>(file);
    if (!manifest) continue;
    const directory = dirname(file);
    const path = relativePosix(root, directory);
    const technologies = ["javascript"];
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    if (existsSync(join(directory, "tsconfig.json"))) technologies.push("typescript");
    if ("react" in deps) technologies.push("react");
    if ("next" in deps) technologies.push("nextjs");
    if ("vite" in deps) technologies.push("vite");
    if ("vitest" in deps) technologies.push("vitest");
    if (
      "storybook" in deps ||
      Object.keys(deps).some((dependency) => dependency.startsWith("@storybook/"))
    )
      technologies.push("storybook");
    if ("lighthouse" in deps || "@lhci/cli" in deps) technologies.push("lighthouse");
    components.push({
      name: manifest.name ?? (path === "." ? basename(root) : basename(directory)),
      path,
      kind: "package",
      technologies,
      capabilities: packageCapabilities(root, directory, manifest.scripts ?? {}),
    });
  }

  for (const file of files.filter((path) => basename(path) === "pyproject.toml")) {
    const directory = dirname(file);
    const path = relativePosix(root, directory);
    if (components.some((component) => component.path === path)) continue;
    components.push({
      name: path === "." ? basename(root) : basename(directory),
      path,
      kind: "python",
      technologies: ["python"],
      capabilities: {},
    });
  }

  const cargoManifests = files
    .filter((path) => basename(path) === "Cargo.toml")
    .map((file) => ({ path: relativePosix(root, dirname(file)), workspace: cargoWorkspace(file) }));
  const cargoPaths = cargoManifests.map((manifest) => manifest.path);
  const workspaceMembers = new Set(
    cargoManifests.flatMap((manifest) =>
      manifest.workspace
        ? cargoWorkspaceMembers(manifest.path, manifest.workspace, cargoPaths)
        : [],
    ),
  );
  for (const manifest of cargoManifests) {
    if (!manifest.workspace && workspaceMembers.has(manifest.path)) continue;
    const { path } = manifest;
    components.push({
      name: path === "." ? basename(root) : basename(path),
      path,
      kind: "rust",
      technologies: ["rust"],
      capabilities: structuredClone(
        manifest.workspace ? cargoWorkspaceCapabilities : cargoPackageCapabilities,
      ),
    });
  }

  for (const file of files.filter((path) => path.endsWith(".sln") || path.endsWith(".csproj"))) {
    const directory = dirname(file);
    const path = relativePosix(root, directory);
    if (components.some((component) => component.path === path && component.kind === "dotnet"))
      continue;
    const target = basename(file);
    components.push({
      name: path === "." ? basename(root) : basename(directory),
      path,
      kind: "dotnet",
      technologies: ["dotnet"],
      capabilities: {
        "format:check": ["dotnet", "format", target, "--verify-no-changes"],
        build: ["dotnet", "build", target, "--no-restore"],
        test: ["dotnet", "test", target, "--no-build"],
        "test:unit": ["dotnet", "test", target, "--no-build"],
      },
    });
  }

  if (!components.some((component) => component.path === ".")) {
    const commands = (config ?? loadConfig(root)).capabilityCommands?.["."];
    if (commands && Object.keys(commands).length > 0) {
      components.push({
        name: basename(root),
        path: ".",
        kind: "repository",
        technologies: [],
        capabilities: structuredClone(commands),
      });
    }
  }

  return components.sort(
    (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
  );
}

const cargoPackageCapabilities: Partial<Record<Capability, string[]>> = {
  "format:check": ["cargo", "fmt", "--check"],
  lint: ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"],
  build: ["cargo", "build", "--locked"],
  test: ["cargo", "test", "--locked"],
  "test:unit": ["cargo", "test", "--locked", "--lib"],
  "test:integration": ["cargo", "test", "--locked", "--tests"],
};

// A workspace root validates every member explicitly: without `--workspace`,
// Cargo only covers `default-members` (or the root package) from the root.
const cargoWorkspaceCapabilities: Partial<Record<Capability, string[]>> = {
  "format:check": ["cargo", "fmt", "--all", "--check"],
  lint: [
    "cargo",
    "clippy",
    "--workspace",
    "--all-targets",
    "--all-features",
    "--",
    "-D",
    "warnings",
  ],
  build: ["cargo", "build", "--workspace", "--locked"],
  test: ["cargo", "test", "--workspace", "--locked"],
  "test:unit": ["cargo", "test", "--workspace", "--locked", "--lib"],
  "test:integration": ["cargo", "test", "--workspace", "--locked", "--tests"],
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

type CargoWorkspace = { members: string[]; exclude: string[] };

function cargoWorkspace(file: string): CargoWorkspace | undefined {
  let manifest: { workspace?: { members?: unknown; exclude?: unknown } };
  try {
    manifest = TOML.parse(readFileSync(file, "utf8")) as typeof manifest;
  } catch {
    // An unparsable manifest stays a plain crate component; Cargo reports the error itself.
    return undefined;
  }
  if (!manifest.workspace || typeof manifest.workspace !== "object") return undefined;
  return {
    members: stringArray(manifest.workspace.members),
    exclude: stringArray(manifest.workspace.exclude),
  };
}

function cargoWorkspaceMembers(
  workspacePath: string,
  workspace: CargoWorkspace,
  cargoPaths: readonly string[],
): string[] {
  const resolve = (pattern: string) =>
    posix.normalize(posix.join(workspacePath, pattern.replaceAll("\\", "/"))).replace(/\/$/, "");
  const members = workspace.members.map((pattern) => new Glob(resolve(pattern)));
  const excluded = new Set(workspace.exclude.map(resolve));
  return cargoPaths.filter(
    (path) =>
      path !== workspacePath && !excluded.has(path) && members.some((member) => member.match(path)),
  );
}

/** The same bounded workspace/member selection used by component discovery. */
export function cargoComponentManifestPaths(root: string, componentPath: string): string[] {
  const manifest = join(root, componentPath, "Cargo.toml");
  const workspace = cargoWorkspace(manifest);
  if (!workspace) return [manifest];
  const paths = walkFiles(root, 4)
    .filter(
      (path) =>
        basename(path) === "Cargo.toml" && lstatSync(path, { throwIfNoEntry: false })?.isFile(),
    )
    .map((path) => relativePosix(root, dirname(path)));
  return [componentPath, ...cargoWorkspaceMembers(componentPath, workspace, paths)].map((path) =>
    join(root, path, "Cargo.toml"),
  );
}

function packageCapabilities(
  root: string,
  directory: string,
  scripts: Record<string, string>,
): Partial<Record<Capability, string[]>> {
  const manager =
    existsSync(join(directory, "bun.lock")) ||
    existsSync(join(directory, "bun.lockb")) ||
    existsSync(join(root, "bun.lock")) ||
    existsSync(join(root, "bun.lockb"))
      ? "bun"
      : "npm";
  const result: Partial<Record<Capability, string[]>> = {};
  for (const capability of capabilities) {
    const script = scriptCandidates[capability].find((candidate) => candidate in scripts);
    if (script)
      result[capability] = manager === "bun" ? ["bun", "run", script] : ["npm", "run", script];
  }
  return result;
}

export function declaredComponents(root: string, config = loadConfig(root)): Component[] {
  return applyCapabilityCommands(discoverComponents(root, config), config);
}

function configuredComponents(root: string, config: ToolingConfig): Component[] {
  return applyConventionConfigurations(root, declaredComponents(root, config));
}

function applyDependencyResolution(
  components: Component[],
  resolution: DependencyResolution,
): Component[] {
  if (resolution === "distribution") return components;
  return components.map((component) => {
    if (component.kind !== "rust") return component;
    const resolved: Partial<Record<Capability, string[]>> = {};
    for (const capability of capabilities) {
      const command = component.capabilities[capability];
      if (!command) continue;
      resolved[capability] =
        command[0] === "cargo"
          ? command.filter((argument) => argument !== "--locked")
          : [...command];
    }
    return { ...component, capabilities: resolved };
  });
}

export function planChecks(options: {
  root?: string;
  tier: string;
  component?: string;
  configPath?: string;
  dependencyResolution?: DependencyResolution;
}) {
  const root = options.root ?? repositoryRoot();
  const config = loadConfig(root, options.configPath);
  const dependencyResolution = options.dependencyResolution ?? "distribution";
  const configured = config.tiers?.[options.tier] ?? defaultTiers[options.tier];
  if (!configured) throw new Error(`Unknown tier: ${options.tier}`);
  validateCapabilities(configured);
  const conventionRequired = conventionRequiredCapabilities(root, options.tier);
  const selected = [...new Set([...configured, ...conventionRequired])];
  const components = applyDependencyResolution(
    configuredComponents(root, config),
    dependencyResolution,
  ).filter(
    (component) =>
      !options.component ||
      component.name === options.component ||
      component.path === options.component,
  );
  if (options.component && components.length === 0)
    throw new Error(`Unknown component: ${options.component}`);
  const checks: PlannedCheck[] = [];
  // Equivalent discoveries (for example a root package and a root Cargo workspace)
  // can share a working directory and exact command. Run that invocation once and
  // keep every owning component in `components` so attribution is not lost.
  const plannedInvocations = new Map<string, PlannedCheck>();
  for (const component of components) {
    for (const capability of selected) {
      const command = component.capabilities[capability];
      if (!command) continue;
      const invocation = JSON.stringify([component.path, capability, command]);
      const existing = plannedInvocations.get(invocation);
      if (existing) {
        // Append every discovered owner, even when two owners share a name.
        existing.components = [...(existing.components ?? [existing.component]), component.name];
        continue;
      }
      const check: PlannedCheck = {
        capability,
        component: component.name,
        path: component.path,
        command,
      };
      plannedInvocations.set(invocation, check);
      checks.push(check);
    }
  }

  const availableCapabilities = new Set(checks.map((check) => check.capability));
  const requiredCapabilities = new Set([
    ...(config.requiredCapabilities ?? []),
    ...conventionRequired,
  ]);
  const optionalCapabilities = new Set(config.optionalCapabilities ?? []);
  const scope = components.length === 1 ? components[0]!.name : "selected components";
  const missing: { capability: Capability; component: string; optional: boolean }[] = [];
  for (const capability of selected) {
    if (availableCapabilities.has(capability)) continue;
    if (requiredCapabilities.has(capability))
      missing.push({ capability, component: scope, optional: false });
    else if (optionalCapabilities.has(capability) || capability === "load:smoke") {
      missing.push({
        capability,
        component: scope,
        optional: optionalCapabilities.has(capability),
      });
    }
  }

  return {
    profile: config.profile,
    tier: options.tier,
    dependencyResolution,
    checks,
    missing,
    conventionRequiredCapabilities: conventionRequired,
    conventionRefs: config.conventionRefs ?? [],
  };
}

function applyCapabilityCommands(components: Component[], config: ToolingConfig): Component[] {
  return components.map((component) => ({
    ...component,
    capabilities: {
      ...component.capabilities,
      ...config.capabilityCommands?.[component.name],
      ...config.capabilityCommands?.[component.path],
    },
  }));
}

function missingDiagnostics(
  missing: { capability: Capability; component: string; optional: boolean }[],
): Diagnostic[] {
  return missing.map((item) => ({
    code: item.optional ? "optional-capability-unavailable" : "capability-unavailable",
    message: `${item.capability} is unavailable for ${item.component}`,
  }));
}

function nestedComponentSubtrees(
  root: string,
  plannedPath: string,
  componentPaths: readonly string[],
): string[] {
  const cwd = plannedPath === "." ? root : join(root, plannedPath);
  const prefix = plannedPath === "." ? "" : `${plannedPath}/`;
  return [...new Set(componentPaths)]
    .filter(
      (path) =>
        path !== "." && path !== plannedPath && (plannedPath === "." || path.startsWith(prefix)),
    )
    .map((path) => relativePosix(cwd, join(root, path)))
    .filter((path) => path !== "." && !path.startsWith("../"))
    .sort();
}

function executePlannedCheck(
  root: string,
  planned: PlannedCheck,
  componentPaths: readonly string[],
) {
  const started = Date.now();
  const cwd = planned.path === "." ? root : join(root, planned.path);
  const result = runCommand(planned.command[0], planned.command.slice(1), cwd);
  let processStatus: ResultStatus = result.error
    ? "error"
    : result.status === 0
      ? "passed"
      : "failed";
  if (
    planned.capability === "load:smoke" &&
    (result.errorCode === "ENOENT" || (!result.error && result.status === 2))
  ) {
    processStatus = "unavailable";
  }
  const testExecution = collectTestExecutionEvidence({
    cwd,
    capability: planned.capability,
    command: planned.command,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  const testDiscovery = collectTestDiscoveryEvidence({
    cwd,
    capability: planned.capability,
    command: planned.command,
    excludedSubtrees: nestedComponentSubtrees(root, planned.path, componentPaths),
  });
  const testScope = reconcileTestScope(testDiscovery, testExecution);
  const zeroExecutedCases =
    processStatus === "passed" &&
    testExecution?.status === "available" &&
    testExecution.executedCases === 0;
  const scopeMismatch = processStatus === "passed" && testScope?.status === "mismatch";
  const status: ResultStatus = zeroExecutedCases || scopeMismatch ? "failed" : processStatus;

  return {
    ...planned,
    status,
    processStatus,
    exitCode: result.status,
    durationMs: Date.now() - started,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    errorCode: result.errorCode,
    testExecution,
    testDiscovery,
    testScope,
    failureReason: zeroExecutedCases
      ? "zero-tests-executed"
      : scopeMismatch
        ? "test-discovery-execution-mismatch"
        : undefined,
  };
}

function testEvidenceDiagnostics(completed: ReturnType<typeof executePlannedCheck>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if ((completed.testDiscovery?.excludedFileCount ?? 0) > 0) {
    const examples = completed.testDiscovery?.excludedFiles?.slice(0, 3) ?? [];
    diagnostics.push({
      code: "test-files-excluded-by-runner",
      message: `${completed.capability} for ${completed.component} excludes ${completed.testDiscovery!.excludedFileCount} conventional test file(s)${examples.length > 0 ? `: ${examples.join(", ")}` : ""}`,
    });
  }
  if (completed.failureReason === "zero-tests-executed") {
    diagnostics.push({
      code: "test-zero-executed-cases",
      message: `${completed.capability} for ${completed.component} completed without executing a behavioral test case`,
    });
  } else if (completed.failureReason === "test-discovery-execution-mismatch") {
    diagnostics.push({
      code: "test-discovery-execution-mismatch",
      message: `${completed.capability} for ${completed.component} discovered ${completed.testScope?.discoveredFiles ?? "unknown"} test file(s) but execution reported ${completed.testScope?.executedFiles ?? "unknown"}`,
    });
  }
  return diagnostics;
}

function executionStatus(
  results: readonly { status: ResultStatus }[],
  missingUnavailable = false,
): ResultStatus {
  if (results.some((result) => result.status === "error")) {
    return "error";
  }
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }
  if (missingUnavailable || results.some((result) => result.status === "unavailable")) {
    return "unavailable";
  }
  return "passed";
}

export function runPlan(options: {
  root?: string;
  tier: string;
  component?: string;
  configPath?: string;
  strict?: boolean;
  dependencyResolution?: DependencyResolution;
}): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = options.root ?? repositoryRoot();
  try {
    const plan = planChecks({ ...options, root });
    const config = loadConfig(root, options.configPath);
    const componentPaths = configuredComponents(root, config).map((component) => component.path);
    const selectedComponents = discoverComponents(root, config).filter(
      (component) =>
        !options.component ||
        component.name === options.component ||
        component.path === options.component,
    );
    const convention = runConventionChecks(root, selectedComponents);
    const diagnostics = [...convention.diagnostics, ...missingDiagnostics(plan.missing)];
    if (convention.status !== "passed") {
      return envelope(
        "run",
        convention.status,
        started,
        {
          ...plan,
          root,
          strict: Boolean(options.strict),
          conventionResults: convention.results,
          results: [],
        },
        diagnostics,
      );
    }

    const results: ReturnType<typeof executePlannedCheck>[] = [];
    for (const planned of plan.checks) {
      const completed = executePlannedCheck(root, planned, componentPaths);
      results.push(completed);
      diagnostics.push(...testEvidenceDiagnostics(completed));
      if (completed.status !== "passed") break;
    }
    const status = executionStatus(
      results,
      plan.missing.some((item) => item.capability === "load:smoke") ||
        Boolean(options.strict && plan.missing.some((item) => !item.optional)),
    );
    return envelope(
      "run",
      status,
      started,
      {
        ...plan,
        root,
        strict: Boolean(options.strict),
        conventionResults: convention.results,
        results,
      },
      diagnostics,
    );
  } catch (error) {
    return envelope("run", "error", started, { root, tier: options.tier }, [
      { code: "invalid-run", message: error instanceof Error ? error.message : String(error) },
    ]);
  }
}

export function writeReport(report: ResultEnvelope<Record<string, unknown>>, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function inspect(root = repositoryRoot()): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const components = discoverComponents(root);
  return envelope("inspect", components.length > 0 ? "passed" : "unavailable", started, {
    root,
    technologies: [...new Set(components.flatMap((component) => component.technologies))].sort(),
    components,
  });
}

export function check(
  root: string,
  capability: Capability,
  component?: string,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  try {
    const config = loadConfig(root);
    const configured = configuredComponents(root, config);
    const componentPaths = configured.map((item) => item.path);
    const selected = configured.filter(
      (item) => !component || item.name === component || item.path === component,
    );
    const checks = selected.flatMap((item) =>
      item.capabilities[capability]
        ? [
            {
              capability,
              component: item.name,
              path: item.path,
              command: item.capabilities[capability]!,
            },
          ]
        : [],
    );
    if (checks.length === 0)
      return envelope("check", "unavailable", started, { capability, results: [] }, [
        { code: "capability-unavailable", message: `${capability} is unavailable` },
      ]);
    const results = checks.map((item) => executePlannedCheck(root, item, componentPaths));
    const diagnostics = results.flatMap(testEvidenceDiagnostics);
    const status = executionStatus(results);
    return envelope("check", status, started, { capability, results }, diagnostics);
  } catch (error) {
    return envelope("check", "error", started, { capability, results: [] }, [
      {
        code: "invalid-check",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

export function affected(root: string, base = "HEAD"): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const result = runCommand("git", ["diff", "--name-only", `${base}...HEAD`], root);
  if (result.status !== 0)
    return envelope(
      "affected",
      "error",
      started,
      { base, changedFiles: [], affectedComponents: [] },
      [{ code: "git-diff-failed", message: result.stderr || `Could not compare ${base}` }],
    );
  const changedFiles = result.stdout.split(/\r?\n/).filter(Boolean);
  const components = discoverComponents(root);
  const affectedComponents = components.filter((component) =>
    component.path === "."
      ? changedFiles.length > 0
      : changedFiles.some(
          (path) => path === component.path || path.startsWith(`${component.path}/`),
        ),
  );
  return envelope("affected", "passed", started, {
    base,
    changedFiles,
    affectedComponents: affectedComponents.map((component) => component.name),
    recommendedCapabilities: [
      ...new Set(affectedComponents.flatMap((component) => Object.keys(component.capabilities))),
    ].sort(),
  });
}

export function doctor(root = repositoryRoot()): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const checks = ["git", "bun"].map((name) => {
    const available = commandAvailable(name);
    return {
      name,
      status: available ? "passed" : "unavailable",
      message: available ? `${name} is available` : `${name} is unavailable`,
    };
  });
  return envelope(
    "doctor",
    checks.some((item) => item.status === "unavailable") ? "unavailable" : "passed",
    started,
    { root, checks },
  );
}

export function planEnvelope(
  root: string,
  tier: string,
  component?: string,
  configPath?: string,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  try {
    const plan = planChecks({ root, tier, component, configPath });
    return envelope("plan", plan.checks.length > 0 ? "passed" : "unavailable", started, {
      root,
      ...plan,
    });
  } catch (error) {
    return envelope("plan", "error", started, { root, tier }, [
      { code: "invalid-plan", message: error instanceof Error ? error.message : String(error) },
    ]);
  }
}

function envelope(
  operation: ResultEnvelope<Record<string, unknown>>["operation"],
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}
