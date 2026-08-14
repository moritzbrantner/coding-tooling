import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const scriptCandidates: Record<Capability, string[]> = {
  "format:check": ["format:check", "check:format"],
  lint: ["lint"],
  typecheck: ["typecheck", "check-types"],
  build: ["build"],
  test: ["test"],
  "test:unit": ["test:unit", "test"],
  "test:integration": ["test:integration"],
  "test:e2e": ["test:e2e"],
};

export function loadConfig(root: string, configuredPath = ".coding-tooling.json"): ToolingConfig {
  const path = join(root, configuredPath);
  if (!existsSync(path)) return { schemaVersion: 1 };
  const value = readJson<ToolingConfig>(path);
  if (!value || value.schemaVersion !== 1)
    throw new Error(`${configuredPath} must use schemaVersion 1`);
  for (const values of Object.values(value.tiers ?? {})) validateCapabilities(values);
  validateCapabilities(value.requiredCapabilities ?? []);
  return value;
}

function validateCapabilities(values: readonly string[]): void {
  for (const value of values) {
    if (!capabilities.includes(value as Capability))
      throw new Error(`Unknown capability: ${value}`);
  }
}

export function discoverComponents(root = repositoryRoot()): Component[] {
  const files = walkFiles(root, 4);
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
    components.push({
      name: manifest.name ?? (path === "." ? basename(root) : basename(directory)),
      path,
      kind: "package",
      technologies,
      capabilities: packageCapabilities(root, directory, manifest.scripts ?? {}),
    });
  }

  for (const file of files.filter((path) => basename(path) === "Cargo.toml")) {
    const directory = dirname(file);
    const path = relativePosix(root, directory);
    components.push({
      name: path === "." ? basename(root) : basename(directory),
      path,
      kind: "rust",
      technologies: ["rust"],
      capabilities: {
        "format:check": ["cargo", "fmt", "--check"],
        lint: ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"],
        build: ["cargo", "build", "--locked"],
        test: ["cargo", "test", "--locked"],
        "test:unit": ["cargo", "test", "--locked", "--lib"],
        "test:integration": ["cargo", "test", "--locked", "--tests"],
      },
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

  return components.sort(
    (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
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

export function planChecks(options: {
  root?: string;
  tier: string;
  component?: string;
  configPath?: string;
}) {
  const root = options.root ?? repositoryRoot();
  const config = loadConfig(root, options.configPath);
  const selected = config.tiers?.[options.tier] ?? defaultTiers[options.tier];
  if (!selected) throw new Error(`Unknown tier: ${options.tier}`);
  validateCapabilities(selected);
  const components = discoverComponents(root).filter(
    (component) =>
      !options.component ||
      component.name === options.component ||
      component.path === options.component,
  );
  if (options.component && components.length === 0)
    throw new Error(`Unknown component: ${options.component}`);
  const checks: PlannedCheck[] = [];
  const missing: { capability: Capability; component: string }[] = [];
  for (const component of components) {
    for (const capability of selected) {
      const command = component.capabilities[capability];
      if (command)
        checks.push({ capability, component: component.name, path: component.path, command });
      else missing.push({ capability, component: component.name });
    }
  }
  return {
    profile: config.profile,
    tier: options.tier,
    checks,
    missing,
    conventionRefs: config.conventionRefs ?? [],
  };
}

export function runPlan(options: {
  root?: string;
  tier: string;
  component?: string;
  configPath?: string;
  strict?: boolean;
}): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = options.root ?? repositoryRoot();
  try {
    const plan = planChecks({ ...options, root });
    const results = plan.checks.map((planned) => {
      const checkStarted = Date.now();
      const cwd = planned.path === "." ? root : join(root, planned.path);
      const result = runCommand(planned.command[0], planned.command.slice(1), cwd);
      return {
        ...planned,
        status: result.error ? "error" : result.status === 0 ? "passed" : "failed",
        exitCode: result.status,
        durationMs: Date.now() - checkStarted,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
    });
    const status: ResultStatus = results.some((result) => result.status === "error")
      ? "error"
      : results.some((result) => result.status === "failed")
        ? "failed"
        : options.strict && plan.missing.length > 0
          ? "unavailable"
          : "passed";
    return envelope(
      "run",
      status,
      started,
      { ...plan, root, strict: Boolean(options.strict), results },
      plan.missing.map((item) => ({
        code: "capability-unavailable",
        message: `${item.capability} is unavailable for ${item.component}`,
      })),
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
  const selected = discoverComponents(root).filter(
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
  const results = checks.map((item) => {
    const result = runCommand(
      item.command[0],
      item.command.slice(1),
      item.path === "." ? root : join(root, item.path),
    );
    return {
      ...item,
      status: result.error ? "error" : result.status === 0 ? "passed" : "failed",
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
  });
  const status = results.some((item) => item.status === "error")
    ? "error"
    : results.some((item) => item.status === "failed")
      ? "failed"
      : "passed";
  return envelope("check", status, started, { capability, results });
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
