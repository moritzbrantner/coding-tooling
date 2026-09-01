import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { conventionRegistryCommand } from "./convention-registry.ts";
import { discoverComponents } from "./core.ts";
import {
  capabilities,
  type Capability,
  type Component,
  type ResultEnvelope,
  type ToolingConfig,
} from "./model.ts";
import { readJson, repositoryRoot, walkFiles } from "./shared.ts";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type BootstrapOptions = {
  root?: string;
  conventionsRoot?: string;
  registryPath?: string;
};

const moduleForTechnology: Record<string, string> = {
  rust: "rust",
  typescript: "typescript",
  react: "react",
  nextjs: "nextjs",
  vite: "vite",
  vitest: "vitest",
  playwright: "playwright",
  storybook: "storybook",
  lighthouse: "lighthouse",
  "testing-library": "testing-library",
  "tanstack-query": "tanstack-query",
  "react-hook-form": "react-hook-form",
  zustand: "zustand",
  "moritzbrantner-ui": "moritzbrantner-ui",
};

const capabilityOrder = new Map(capabilities.map((capability, index) => [capability, index]));

function orderedCapabilities(values: Iterable<Capability>): Capability[] {
  return [...new Set(values)].sort(
    (left, right) =>
      (capabilityOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (capabilityOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function packageTechnologies(root: string): Set<string> {
  const technologies = new Set<string>();
  for (const path of walkFiles(root, 4).filter(
    (candidate) => basename(candidate) === "package.json",
  )) {
    const manifest = readJson<PackageManifest>(path);
    if (!manifest) continue;
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    if ("@playwright/test" in deps || "playwright" in deps) technologies.add("playwright");
    if ("@testing-library/react" in deps) technologies.add("testing-library");
    if ("@tanstack/react-query" in deps) technologies.add("tanstack-query");
    if ("react-hook-form" in deps) technologies.add("react-hook-form");
    if ("zustand" in deps) technologies.add("zustand");
    if ("@moritzbrantner/ui" in deps) technologies.add("moritzbrantner-ui");
  }
  return technologies;
}

function repositoryTechnologies(root: string, components: Component[]): string[] {
  const technologies = new Set(components.flatMap((component) => component.technologies));
  for (const technology of packageTechnologies(root)) technologies.add(technology);
  if (walkFiles(root, 3).some((path) => basename(path).startsWith("Dockerfile"))) {
    technologies.add("dockerfile");
  }
  return [...technologies].sort();
}

function recommendedModules(
  root: string,
  components: Component[],
  technologies: string[],
): string[] {
  const modules = new Set<string>(["environment", "git"]);
  if (components.length > 1) modules.add("dependencies");
  if (basename(root).toLowerCase().includes("template")) modules.add("template-authoring");
  if (technologies.includes("react")) modules.add("ui");
  if (technologies.includes("dockerfile")) modules.add("dockerfile");
  for (const technology of technologies) {
    const module = moduleForTechnology[technology];
    if (module) modules.add(module);
  }
  return [...modules].sort();
}

function availableCapabilities(components: Component[]): Set<Capability> {
  return new Set(
    components.flatMap((component) => Object.keys(component.capabilities) as Capability[]),
  );
}

function recommendedConfig(
  components: Component[],
  technologies: string[],
  root: string,
): ToolingConfig {
  const required = new Set<Capability>();
  const optional = new Set<Capability>();
  const available = availableCapabilities(components);
  const hasRust = components.some((component) => component.kind === "rust");
  const hasDotnet = components.some((component) => component.kind === "dotnet");
  const hasPackage = components.some((component) => component.kind === "package");
  const hasTypescript = technologies.includes("typescript");
  const hasReact = technologies.includes("react") || technologies.includes("nextjs");
  const isTemplate = basename(root).toLowerCase().includes("template");

  if (hasRust || hasDotnet || hasPackage) {
    required.add("format:check");
    required.add("build");
    required.add("test:unit");
  }
  if (hasRust || hasPackage) required.add("lint");
  if (hasTypescript) required.add("typecheck");

  optional.add("test:integration");
  if (hasReact) {
    optional.add("test:e2e:smoke");
    optional.add("test:accessibility");
  }
  if (technologies.includes("playwright")) optional.add("test:e2e");
  if (technologies.includes("storybook")) {
    optional.add("storybook:check");
    optional.add("test:visual");
  }
  if (technologies.includes("lighthouse")) optional.add("web:audit");
  if (hasRust) optional.add("benchmark:smoke");
  if (isTemplate) optional.add("template:smoke");

  for (const capability of [
    "test:integration",
    "test:e2e",
    "test:e2e:smoke",
    "test:accessibility",
    "test:visual",
    "package:check",
    "dependencies:audit",
    "benchmark",
    "benchmark:smoke",
    "storybook:check",
    "web:audit",
    "template:smoke",
  ] as const) {
    if (available.has(capability)) optional.add(capability);
  }

  for (const capability of required) optional.delete(capability);
  const fast = orderedCapabilities(required);
  const full = orderedCapabilities([...required, ...optional]);
  const tiers: Record<string, Capability[]> = { fast, full };
  if (optional.has("test:integration")) tiers.integration = ["test:integration"];

  const e2e = orderedCapabilities(
    ["test:e2e:smoke", "test:e2e", "test:accessibility"].filter((capability) =>
      optional.has(capability as Capability),
    ) as Capability[],
  );
  if (e2e.length > 0) tiers.e2e = e2e;

  const performance = orderedCapabilities(
    ["benchmark:smoke", "benchmark"].filter((capability) =>
      optional.has(capability as Capability),
    ) as Capability[],
  );
  if (performance.length > 0) tiers.performance = performance;

  return {
    schemaVersion: 1,
    profile: "repository-foundation-v1",
    tiers,
    requiredCapabilities: fast,
    optionalCapabilities: orderedCapabilities(optional),
  };
}

export function repositoryFoundationRecommendation(root = repositoryRoot()): {
  root: string;
  components: Component[];
  technologies: string[];
  modules: string[];
  config: ToolingConfig;
} {
  const resolvedRoot = resolve(root);
  const components = discoverComponents(resolvedRoot);
  const technologies = repositoryTechnologies(resolvedRoot, components);
  return {
    root: resolvedRoot,
    components,
    technologies,
    modules: recommendedModules(resolvedRoot, components, technologies),
    config: recommendedConfig(components, technologies, resolvedRoot),
  };
}

function envelope(
  status: ResultEnvelope<Record<string, unknown>>["status"],
  started: number,
  data: Record<string, unknown>,
  diagnostics: ResultEnvelope<Record<string, unknown>>["diagnostics"] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "bootstrap",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function bootstrapRepository(
  action: "plan" | "apply",
  options: BootstrapOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? repositoryRoot());
  try {
    const recommendation = repositoryFoundationRecommendation(root);
    if (recommendation.components.length === 0) {
      return envelope("unavailable", started, recommendation, [
        {
          code: "repository-components-unavailable",
          message:
            "No supported code components were discovered; repository bootstrap was not applied",
        },
      ]);
    }
    if (action === "plan") return envelope("passed", started, recommendation);

    const configPath = join(root, ".coding-tooling.json");
    const configPresent = existsSync(configPath);
    const conventionsPresent = existsSync(join(root, "conventions.json"));
    const conventions = conventionRegistryCommand(
      conventionsPresent ? "add" : "init",
      recommendation.modules,
      {
        root,
        conventionsRoot: options.conventionsRoot,
        registryPath: options.registryPath,
      },
    );
    if (conventions.status !== "passed") {
      return envelope(
        conventions.status,
        started,
        {
          ...recommendation,
          configPath: ".coding-tooling.json",
          configChanged: false,
          conventions: conventions.data,
        },
        conventions.diagnostics,
      );
    }

    if (!configPresent) {
      writeFileSync(configPath, `${JSON.stringify(recommendation.config, null, 2)}\n`, "utf8");
    }

    return envelope("passed", started, {
      ...recommendation,
      configPath: ".coding-tooling.json",
      configChanged: !configPresent,
      conventions: conventions.data,
    });
  } catch (error) {
    return envelope("error", started, { root, action }, [
      {
        code: "repository-bootstrap-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
