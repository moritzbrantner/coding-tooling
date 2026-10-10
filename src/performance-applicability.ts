import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { cargoComponentManifestPaths, declaredComponents, loadConfig } from "./core.ts";
import { fleetAuthorityGraph } from "./fleet-authority-graph.ts";
import type { Component, Diagnostic, ResultEnvelope } from "./model.ts";
import { parsePerformanceContract, performanceContractPath } from "./performance-contract.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { runCommand, walkFiles } from "./shared.ts";

const families = [
  "benchmark-smoke",
  "hotspots",
  "memory",
  "browser-audit",
  "react-render-budget",
  "runtime",
  "load-smoke",
  "startup",
  "frame-stall",
  "size-budget",
  "work-complexity",
] as const;
type Family = (typeof families)[number];
const familyCapabilities: Record<Family, readonly string[]> = {
  "benchmark-smoke": ["benchmark:smoke"],
  hotspots: ["profile:hotspots"],
  memory: ["profile:memory"],
  "browser-audit": ["web:audit"],
  "react-render-budget": ["benchmark", "profile:runtime"],
  runtime: ["profile:runtime"],
  "load-smoke": ["load:smoke"],
  startup: ["profile:runtime"],
  "frame-stall": ["profile:runtime"],
  "size-budget": ["size:budget"],
  "work-complexity": ["performance:work"],
};
const roles = [
  "rust-kernel",
  "web",
  "react-interaction",
  "dotnet-service",
  "service",
  "mobile",
  "distributable",
] as const;
type Role = (typeof roles)[number];
type Scenario = {
  family: Family;
  capability: string;
  path: string;
  tools: string[];
  platforms: string[];
};
type Declaration = {
  component: string;
  roles: Role[];
  scenarios: Scenario[];
  notApplicable: { family: Family; reason: string }[];
};
type FamilyResult = {
  family: Family;
  state: "supported" | "applicable-missing" | "unsupported-environment" | "not-applicable";
  reason: string;
  command: string[] | null;
  scenario: { path: string; sha256: string } | null;
  missingTools: string[];
};
type AuditData = {
  schemaVersion: "coding-tooling/performance-applicability/v1";
  root: string;
  revision: string | null;
  dirty: boolean | null;
  declarationSha256: string | null;
  environment: { platform: string; arch: string };
  execution: "not-requested";
  components: { name: string; path: string; roles: Role[]; families: FamilyResult[] }[];
  limitations: string[];
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unknown performance applicability field.");
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}
function family(value: unknown): value is Family {
  return families.some((entry) => entry === value);
}
function role(value: unknown): value is Role {
  return roles.some((entry) => entry === value);
}
function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function declarations(root: string): { values: Declaration[]; sha256: string | null } {
  const file = join(root, ".performance/applicability.json");
  if (!existsSync(file)) return { values: [], sha256: null };
  const bytes = readFileSync(file);
  const parsed: unknown = JSON.parse(bytes.toString());
  if (!record(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.components))
    throw new Error("performance applicability must declare schemaVersion 1 and components");
  keys(parsed, ["schemaVersion", "components"]);
  const values = parsed.components.map((value: unknown): Declaration => {
    if (!record(value) || !text(value.component))
      throw new Error("performance component selector must be non-empty");
    keys(value, ["component", "roles", "scenarios", "notApplicable"]);
    const selectedRoles: unknown = value.roles ?? [];
    const selectedScenarios: unknown = value.scenarios ?? [];
    const exceptions: unknown = value.notApplicable ?? [];
    if (
      !Array.isArray(selectedRoles) ||
      !selectedRoles.every(role) ||
      !Array.isArray(selectedScenarios) ||
      !Array.isArray(exceptions)
    )
      throw new Error("performance roles/scenarios/notApplicable must be supported arrays");
    const scenarios = selectedScenarios.map((entry: unknown): Scenario => {
      if (
        !record(entry) ||
        !family(entry.family) ||
        !text(entry.capability) ||
        !text(entry.path) ||
        !texts(entry.tools) ||
        !texts(entry.platforms)
      )
        throw new Error(
          "each performance scenario requires family, capability, path, tools and platforms",
        );
      keys(entry, ["family", "capability", "path", "tools", "platforms"]);
      if (!familyCapabilities[entry.family].includes(entry.capability))
        throw new Error(`Unsupported capability ${entry.capability} for ${entry.family}.`);
      if (
        isAbsolute(entry.path) ||
        entry.path.includes("\\") ||
        entry.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("performance scenario paths must be portable repository-relative paths");
      return {
        family: entry.family,
        capability: entry.capability,
        path: entry.path,
        tools: entry.tools,
        platforms: entry.platforms,
      };
    });
    const notApplicable = exceptions.map((entry: unknown) => {
      if (!record(entry) || !family(entry.family) || !text(entry.reason))
        throw new Error("non-applicability needs a supported family and a reason");
      keys(entry, ["family", "reason"]);
      return { family: entry.family, reason: entry.reason };
    });
    const selectedFamilies = [...scenarios, ...notApplicable].map((entry) => entry.family);
    if (new Set(selectedFamilies).size !== selectedFamilies.length)
      throw new Error("duplicate or conflicting performance family declarations");
    return {
      component: value.component,
      roles: [...new Set(selectedRoles)],
      scenarios,
      notApplicable,
    };
  });
  if (new Set(values.map((value) => value.component)).size !== values.length)
    throw new Error("duplicate performance component selectors");
  return { values, sha256: hash(bytes) };
}
function inferredRoles(root: string, component: Component): Role[] {
  const result = new Set<Role>();
  if (component.kind === "rust") {
    result.add("distributable");
    for (const manifest of cargoComponentManifestPaths(root, component.path)) {
      const cargo: unknown = Bun.TOML.parse(readFileSync(manifest, "utf8"));
      if (record(cargo)) {
        const workspace = record(cargo.workspace) ? cargo.workspace : {};
        const dependencies = {
          ...(record(cargo.dependencies) ? cargo.dependencies : {}),
          ...(record(workspace.dependencies) ? workspace.dependencies : {}),
        };
        if (["axum", "actix-web", "warp", "rocket"].some((name) => name in dependencies))
          result.add("service");
        if (
          (Array.isArray(cargo.bench) && cargo.bench.length) ||
          walkFiles(join(dirname(manifest), "benches"), 1).some((file) => file.endsWith(".rs"))
        )
          result.add("rust-kernel");
      }
    }
  }
  if (
    component.kind === "dotnet" &&
    walkFiles(join(root, component.path), 2).some(
      (file) =>
        file.endsWith(".csproj") &&
        /Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web["']/.test(readFileSync(file, "utf8")),
    )
  )
    result.add("dotnet-service");
  if (component.technologies.includes("react")) {
    result.add("web");
    result.add("react-interaction");
  }
  if (component.technologies.includes("vite") || component.technologies.includes("nextjs"))
    result.add("web");
  const manifest = join(root, component.path, "package.json");
  if (existsSync(manifest)) {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (record(parsed)) {
      const dependencies = {
        ...(record(parsed.dependencies) ? parsed.dependencies : {}),
        ...(record(parsed.devDependencies) ? parsed.devDependencies : {}),
      };
      if (
        ["express", "fastify", "hono", "koa", "@nestjs/core"].some((name) => name in dependencies)
      )
        result.add("service");
      if ("expo" in dependencies || "react-native" in dependencies) {
        result.delete("web");
        result.delete("react-interaction");
        result.add("mobile");
      }
      if (parsed.private !== true && (parsed.exports !== undefined || parsed.bin !== undefined))
        result.add("distributable");
    }
  }
  if (readRepositoryMetadata(root).metadata?.kind === "service") {
    result.add(component.kind === "dotnet" ? "dotnet-service" : "service");
  }
  return [...result];
}
/**
 * Work complexity applies only where the repository itself declares operations in a v2
 * performance contract; the audit never invents which product operations matter.
 */
function declaresWorkOperations(root: string, diagnostics: Diagnostic[]): boolean {
  const file = join(root, performanceContractPath);
  if (!existsSync(file)) return false;
  try {
    // Validate every existing contract (any version) before reading its operations.
    return parsePerformanceContract(JSON.parse(readFileSync(file, "utf8"))).operations.length > 0;
  } catch (error: unknown) {
    diagnostics.push({
      code: "performance-contract-invalid",
      path: performanceContractPath,
      message: `Work operations are unresolved: ${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
}
const roleFamilies: Record<Role, readonly Family[]> = {
  "rust-kernel": ["benchmark-smoke", "hotspots", "memory", "size-budget"],
  web: ["browser-audit", "runtime", "size-budget"],
  "react-interaction": ["react-render-budget"],
  "dotnet-service": ["benchmark-smoke", "runtime", "memory", "load-smoke"],
  service: ["runtime", "load-smoke"],
  mobile: ["startup", "frame-stall", "memory", "size-budget"],
  distributable: ["size-budget"],
};
/** PATH existence only: lookup never launches a collector or repository script. */
function executableAvailable(tool: string, cwd: string): boolean {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const local = isAbsolute(tool) || tool.includes("/") || tool.includes("\\");
  const candidates = local
    ? [resolve(cwd, tool)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => [
          join(directory, tool),
          ...extensions.filter(Boolean).map((extension) => join(directory, `${tool}${extension}`)),
        ]);
  return candidates.some((file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
function observeFamily(
  root: string,
  component: Component,
  applicable: Set<Family>,
  declared: Declaration | undefined,
  selected: Family,
  available: (tool: string, cwd: string) => boolean,
  diagnostics: Diagnostic[],
): FamilyResult {
  const exception = declared?.notApplicable.find((value) => value.family === selected);
  const scenario = declared?.scenarios.find((value) => value.family === selected);
  const base = { family: selected, command: null, scenario: null, missingTools: [] };
  if (exception) return { ...base, state: "not-applicable", reason: exception.reason };
  if (!applicable.has(selected) && !scenario)
    return {
      ...base,
      state: "not-applicable",
      reason:
        "No matching repository shape or declared workload role; this is a structural applicability assessment.",
    };
  if (!scenario)
    return {
      ...base,
      state: "applicable-missing",
      reason:
        "Applicable shape/workload has no repository-owned representative scenario declaration.",
    };
  if (selected === "work-complexity" && !applicable.has(selected))
    return {
      ...base,
      state: "applicable-missing",
      reason: "Declared work-complexity wiring has no operations in a schemaVersion 2 contract.",
    };
  const command = Object.entries(component.capabilities).find(
    ([name]) => name === scenario.capability,
  )?.[1];
  const absolute = resolve(root, scenario.path);
  let scenarioHash: string | null = null;
  try {
    const resolved = realpathSync(absolute);
    const local = relative(realpathSync(root), resolved);
    if (
      isAbsolute(local) ||
      local === ".." ||
      local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      !lstatSync(absolute).isFile()
    )
      throw new Error("scenario is not a regular in-repository file");
    scenarioHash = hash(readFileSync(absolute));
  } catch {
    diagnostics.push({
      code: "performance-scenario-unavailable",
      path: scenario.path,
      message:
        "Declared representative scenario is missing, unreadable, symlinked or outside the repository.",
    });
  }
  if (!command || !scenarioHash)
    return {
      ...base,
      state: "applicable-missing",
      reason: "Declared scenario lacks an available capability command or valid source file.",
    };
  const evidence = { command, scenario: { path: scenario.path, sha256: scenarioHash } };
  if (scenario.platforms.length && !scenario.platforms.includes(process.platform))
    return {
      ...base,
      ...evidence,
      state: "unsupported-environment",
      reason: `Declared collector does not support ${process.platform}.`,
    };
  const missingTools = [...new Set([command[0]!, ...scenario.tools])].filter(
    (tool) => !available(tool, join(root, component.path)),
  );
  if (missingTools.length)
    return {
      ...base,
      ...evidence,
      missingTools,
      state: "unsupported-environment",
      reason: "Declared command/collector prerequisites are unavailable.",
    };
  return {
    ...base,
    ...evidence,
    state: "supported",
    reason:
      "Representative scenario and capability are declared and structural environment prerequisites are available; measurement has not run.",
  };
}
export function performanceApplicability(
  root: string,
  options: { available?: (tool: string, cwd: string) => boolean } = {},
): ResultEnvelope<AuditData> {
  const started = Date.now();
  const diagnostics: Diagnostic[] = [];
  const resolvedRoot = resolve(root);
  const head = runCommand("git", ["rev-parse", "HEAD"], resolvedRoot);
  const status = runCommand("git", ["status", "--porcelain"], resolvedRoot);
  const data: AuditData = {
    schemaVersion: "coding-tooling/performance-applicability/v1",
    root: resolvedRoot,
    revision: head.status === 0 ? head.stdout.trim() : null,
    dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
    declarationSha256: null,
    environment: { platform: process.platform, arch: process.arch },
    execution: "not-requested",
    components: [],
    limitations: [
      "Applicability is a structural/declared workload assessment, not a semantic architecture verdict.",
      "Supported means wired scenario and declared prerequisite availability, not executed cases, measured performance, collector permissions or threshold satisfaction.",
      "Absent optional prerequisites cannot be inferred; scenario owners must declare their collector requirements.",
    ],
  };
  try {
    const declared = declarations(resolvedRoot);
    data.declarationSha256 = declared.sha256;
    const components = declaredComponents(resolvedRoot, loadConfig(resolvedRoot));
    const workOperations = declaresWorkOperations(resolvedRoot, diagnostics);
    // The contract and its collector belong to the repository root. With several root components,
    // only those exposing performance:work own the family unless none does (missing wiring).
    const rootComponents = components.filter((value) => value.path === ".");
    const collectorRoots = rootComponents.filter((value) => value.capabilities["performance:work"]);
    const workRoots = new Set(collectorRoots.length ? collectorRoots : rootComponents);
    if (!components.length)
      diagnostics.push({
        code: "performance-components-unavailable",
        message: "No supported repository components were discovered; applicability is unresolved.",
      });
    for (const declaration of declared.values)
      if (
        !components.some(
          (value) => value.path === declaration.component || value.name === declaration.component,
        )
      )
        diagnostics.push({
          code: "performance-component-unresolved",
          message: `No component matches ${declaration.component}.`,
          path: ".performance/applicability.json",
        });
    data.components = components.map((component) => {
      const selected = declared.values.filter(
        (value) => value.component === component.path || value.component === component.name,
      );
      if (selected.length > 1)
        throw new Error(`ambiguous performance declarations for ${component.name}`);
      const declaration = selected[0];
      const roleSet = new Set([
        ...inferredRoles(resolvedRoot, component),
        ...(declaration?.roles ?? []),
      ]);
      const selectedRoles = roles.filter((value) => roleSet.has(value));
      const applicable = new Set<Family>(selectedRoles.flatMap((value) => roleFamilies[value]));
      if (workOperations && workRoots.has(component)) applicable.add("work-complexity");
      return {
        name: component.name,
        path: component.path,
        roles: selectedRoles,
        families: families.map((value) =>
          observeFamily(
            resolvedRoot,
            component,
            applicable,
            declaration,
            value,
            options.available ?? executableAvailable,
            diagnostics,
          ),
        ),
      };
    });
  } catch (error: unknown) {
    diagnostics.push({
      code: "performance-applicability-invalid",
      path: ".performance/applicability.json",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    schemaVersion: 1,
    operation: "performance-applicability",
    status: diagnostics.length ? "unavailable" : "passed",
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}
export function fleetPerformanceApplicability(root: string): ResultEnvelope<{
  schemaVersion: "coding-tooling/fleet-performance-applicability/v1";
  root: string;
  repositories: { id: string; report: ReturnType<typeof performanceApplicability> }[];
  excluded: string[];
}> {
  const started = Date.now();
  const graph = fleetAuthorityGraph(root);
  const repositories: { id: string; report: ReturnType<typeof performanceApplicability> }[] = [];
  const excluded: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const entries: unknown[] = Array.isArray(graph.data.repositories) ? graph.data.repositories : [];
  for (const entry of entries) {
    if (!record(entry) || !text(entry.root) || !text(entry.id)) continue;
    if (
      record(entry.metadata) &&
      ["archived", "retiring"].includes(String(entry.metadata.status))
    ) {
      excluded.push(entry.id);
      continue;
    }
    if (!record(entry.metadata))
      diagnostics.push({
        code: "performance-repository-metadata-unavailable",
        path: entry.root,
        message:
          "Maintained status is unresolved; the repository remains visible with conservative shape evidence.",
      });
    const report = performanceApplicability(entry.root);
    repositories.push({ id: entry.id, report });
    diagnostics.push(...report.diagnostics);
  }
  return {
    schemaVersion: 1,
    operation: "fleet-performance-applicability",
    status: diagnostics.length || !repositories.length ? "unavailable" : "passed",
    durationMs: Date.now() - started,
    data: {
      schemaVersion: "coding-tooling/fleet-performance-applicability/v1",
      root: resolve(root),
      repositories,
      excluded,
    },
    diagnostics,
  };
}
