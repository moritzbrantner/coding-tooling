import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { conventionRegistryCommand } from "./convention-registry.ts";
import { discoverComponents, loadConfig } from "./core.ts";
import type {
  Capability,
  Diagnostic,
  ResultEnvelope,
  ResultStatus,
  ToolingConfig,
} from "./model.ts";
import { RENOVATE_PRESET, renovateFoundationRecommendation } from "./renovate.ts";
import { readJson, relativePosix, repositoryRoot, walkFiles } from "./shared.ts";

export type FoundationComponentStatus = "missing" | "adopted" | "invalid" | "unsupported";

type FoundationComponent = {
  status: FoundationComponentStatus;
  diagnostics: Diagnostic[];
  [key: string]: unknown;
};

type CommandRecord = {
  component: string;
  path: string;
  capability: Capability;
  command: string[];
  source: "discovered" | "configured";
};

type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies";
type ConventionExecutableName = "oxlint" | "oxlint-tsgolint";
type ConventionExecutableStatus = "missing" | "adopted" | "invalid";

type ConventionExecutableDeclaration = {
  path: string;
  section: DependencySection;
  version: string;
};

type ConventionExecutableRequirement = {
  name: ConventionExecutableName;
  rules: string[];
  status: ConventionExecutableStatus;
  declarations: ConventionExecutableDeclaration[];
};

type PackageManifest = {
  packageManager?: unknown;
  renovate?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
};

const renovateUnsupportedExtensions = [".jsonc", ".json5", ".renovaterc"] as const;
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const exactPackageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function exactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function component(
  status: FoundationComponentStatus,
  diagnostics: Diagnostic[] = [],
  data: Record<string, unknown> = {},
): FoundationComponent {
  return { status, diagnostics, ...data };
}

function environmentAudit(root: string): FoundationComponent {
  const configPath = join(root, ".repository-environment.toml");
  const scriptPath = join(root, "scripts", "codex-environment.sh");
  const configPresent = existsSync(configPath);
  const scriptPresent = existsSync(scriptPath);
  if (!configPresent && !scriptPresent) {
    return component("missing", [], {
      configPath: ".repository-environment.toml",
      scriptPath: "scripts/codex-environment.sh",
    });
  }

  const diagnostics: Diagnostic[] = [];
  if (!configPresent) {
    diagnostics.push({
      code: "foundation-environment-config-missing",
      message: ".repository-environment.toml is missing from a partial environment-v1 adoption",
      path: ".repository-environment.toml",
    });
  }
  if (!scriptPresent) {
    diagnostics.push({
      code: "foundation-environment-script-missing",
      message: "scripts/codex-environment.sh is missing from a partial environment-v1 adoption",
      path: "scripts/codex-environment.sh",
    });
  }

  if (configPresent) {
    const source = text(configPath);
    if (!/^schema_version\s*=\s*1\s*$/m.test(source)) {
      diagnostics.push({
        code: "foundation-environment-schema-invalid",
        message: ".repository-environment.toml must declare schema_version = 1",
        path: ".repository-environment.toml",
      });
    }
    if (!/^track\s*=\s*"latest-stable"\s*$/m.test(source)) {
      diagnostics.push({
        code: "foundation-environment-track-invalid",
        message: 'environment-v1 must track "latest-stable"',
        path: ".repository-environment.toml",
      });
    }

    const holdHeaders = [...source.matchAll(/^\s*\[compatibility_holds\.([a-z0-9_-]+)\]\s*$/gm)];
    for (let index = 0; index < holdHeaders.length; index += 1) {
      const header = holdHeaders[index]!;
      const start = (header.index ?? 0) + header[0].length;
      const end = holdHeaders[index + 1]?.index ?? source.length;
      const body = source.slice(start, end);
      const candidate = body.match(/^\s*candidate\s*=\s*"([^"]+)"\s*$/m)?.[1];
      const testedRevision = body.match(/^\s*tested_revision\s*=\s*"([^"]+)"\s*$/m)?.[1];
      const reason = body.match(/^\s*reason\s*=\s*"([^"]+)"\s*$/m)?.[1];
      if (
        !candidate ||
        !exactVersion(candidate) ||
        !testedRevision ||
        !/^[0-9a-f]{40}$/i.test(testedRevision) ||
        !reason
      ) {
        diagnostics.push({
          code: "foundation-environment-compatibility-hold-invalid",
          message: `compatibility hold for ${header[1]} is incomplete or invalid`,
          path: ".repository-environment.toml",
        });
      }
    }
  }

  if (scriptPresent) {
    const source = text(scriptPath);
    if (
      !source.startsWith("#!/usr/bin/env bash\n") ||
      !source.includes('"setup"') ||
      !source.includes('"maintenance"')
    ) {
      diagnostics.push({
        code: "foundation-environment-script-invalid",
        message:
          "scripts/codex-environment.sh does not expose the environment-v1 setup/maintenance contract",
        path: "scripts/codex-environment.sh",
      });
    }
  }

  const declarations: Array<{ tool: string; path: string; version: string }> = [];
  const packageManifest = readJson<PackageManifest>(join(root, "package.json"));
  const packageBunVersion =
    typeof packageManifest?.packageManager === "string" &&
    packageManifest.packageManager.startsWith("bun@")
      ? packageManifest.packageManager.slice("bun@".length)
      : null;
  const bunVersionPath = join(root, ".bun-version");
  const versionFileBunVersion = existsSync(bunVersionPath) ? text(bunVersionPath).trim() : null;
  if (
    packageBunVersion !== null &&
    versionFileBunVersion !== null &&
    packageBunVersion !== versionFileBunVersion
  ) {
    diagnostics.push({
      code: "foundation-environment-bun-pin-conflict",
      message: `Bun pins conflict: package.json declares ${packageBunVersion} but .bun-version declares ${versionFileBunVersion}`,
      path: ".bun-version",
    });
  }
  if (packageBunVersion !== null) {
    declarations.push({ tool: "bun", path: "package.json", version: packageBunVersion });
  } else if (versionFileBunVersion !== null) {
    declarations.push({ tool: "bun", path: ".bun-version", version: versionFileBunVersion });
  }

  const nodePath = join(root, ".node-version");
  if (existsSync(nodePath)) {
    declarations.push({ tool: "node", path: ".node-version", version: text(nodePath).trim() });
  }
  const rustPath = join(root, "rust-toolchain.toml");
  if (existsSync(rustPath)) {
    const version = text(rustPath).match(/channel\s*=\s*"([^"]+)"/)?.[1];
    if (version) declarations.push({ tool: "rust", path: "rust-toolchain.toml", version });
    else {
      diagnostics.push({
        code: "foundation-environment-rust-pin-missing",
        message: "rust-toolchain.toml must declare an exact channel",
        path: "rust-toolchain.toml",
      });
    }
  }
  for (const declaration of declarations) {
    if (exactVersion(declaration.version)) continue;
    diagnostics.push({
      code: "foundation-environment-toolchain-pin-floating",
      message: `${declaration.tool} must use an exact x.y.z repository pin`,
      path: declaration.path,
    });
  }

  return component(diagnostics.length > 0 ? "invalid" : "adopted", diagnostics, {
    configPath: ".repository-environment.toml",
    scriptPath: "scripts/codex-environment.sh",
    toolchains: declarations.sort((left, right) => left.tool.localeCompare(right.tool)),
  });
}

function addConventionExecutableRequirement(
  requirements: Map<ConventionExecutableName, Set<string>>,
  name: ConventionExecutableName,
  rule: string,
): void {
  const rules = requirements.get(name) ?? new Set<string>();
  rules.add(rule);
  requirements.set(name, rules);
}

function conventionExecutableRequirements(
  root: string,
): Map<ConventionExecutableName, Set<string>> {
  const requirements = new Map<ConventionExecutableName, Set<string>>();
  const installRoot = join(root, ".conventions", "modules");
  if (!existsSync(installRoot)) return requirements;

  for (const path of walkFiles(installRoot, 20).filter((file) => file.endsWith(".json"))) {
    const value = readJson<unknown>(path);
    if (!isRecord(value) || !isRecord(value.enforcement) || value.enforcement.kind !== "oxlint") {
      continue;
    }
    const rule =
      typeof value.ruleId === "string"
        ? value.ruleId
        : relativePosix(join(root, ".conventions"), path);
    addConventionExecutableRequirement(requirements, "oxlint", rule);

    const config = value.enforcement.config;
    if (isRecord(config) && isRecord(config.options) && config.options.typeAware === true) {
      addConventionExecutableRequirement(requirements, "oxlint-tsgolint", rule);
    }
  }

  return requirements;
}

function conventionPackageManifests(root: string): string[] {
  const paths = new Set<string>();
  const rootManifest = join(root, "package.json");
  if (existsSync(rootManifest)) paths.add(rootManifest);
  for (const discovered of discoverComponents(root)) {
    if (discovered.kind !== "package") continue;
    const path = join(root, discovered.path === "." ? "" : discovered.path, "package.json");
    if (existsSync(path)) paths.add(path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function conventionExecutableDeclarations(
  root: string,
  required: Set<ConventionExecutableName>,
): {
  declarations: Map<ConventionExecutableName, ConventionExecutableDeclaration[]>;
  diagnostics: Diagnostic[];
} {
  const declarations = new Map<ConventionExecutableName, ConventionExecutableDeclaration[]>();
  const diagnostics: Diagnostic[] = [];

  for (const path of conventionPackageManifests(root)) {
    const relativePath = relativePosix(root, path);
    let manifest: unknown;
    try {
      manifest = JSON.parse(text(path)) as unknown;
    } catch {
      diagnostics.push({
        code: "foundation-convention-package-manifest-invalid",
        message: `${relativePath} is not valid JSON`,
        path: relativePath,
      });
      continue;
    }
    if (!isRecord(manifest)) {
      diagnostics.push({
        code: "foundation-convention-package-manifest-invalid",
        message: `${relativePath} must contain a JSON object`,
        path: relativePath,
      });
      continue;
    }

    for (const section of dependencySections) {
      const sectionValue = manifest[section];
      if (sectionValue === undefined) continue;
      if (!isRecord(sectionValue)) {
        diagnostics.push({
          code: "foundation-convention-dependency-section-invalid",
          message: `${relativePath} ${section} must be a JSON object`,
          path: relativePath,
        });
        continue;
      }
      for (const name of required) {
        if (!Object.prototype.hasOwnProperty.call(sectionValue, name)) continue;
        const version = sectionValue[name];
        if (typeof version !== "string") {
          diagnostics.push({
            code: "foundation-convention-tool-version-invalid",
            message: `${name} must use an exact repository-owned package version`,
            path: relativePath,
          });
          continue;
        }
        const values = declarations.get(name) ?? [];
        values.push({ path: relativePath, section, version });
        declarations.set(name, values);
      }
    }
  }

  return { declarations, diagnostics };
}

function conventionExecutableAudit(root: string): {
  status: ConventionExecutableStatus;
  diagnostics: Diagnostic[];
  requiredExecutables: ConventionExecutableRequirement[];
} {
  const requiredByRule = conventionExecutableRequirements(root);
  const required = new Set(requiredByRule.keys());
  if (required.size === 0) {
    return { status: "adopted", diagnostics: [], requiredExecutables: [] };
  }

  const inspection = conventionExecutableDeclarations(root, required);
  const diagnostics = [...inspection.diagnostics];
  const requiredExecutables = [...requiredByRule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, rules]) => {
      const declarations = [...(inspection.declarations.get(name) ?? [])].sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.section.localeCompare(right.section),
      );
      const invalidVersions = declarations.filter(
        (declaration) => !exactPackageVersion.test(declaration.version),
      );
      for (const declaration of invalidVersions) {
        diagnostics.push({
          code: "foundation-convention-tool-version-invalid",
          message: `${name} must use an exact repository-owned package version, got ${declaration.version}`,
          path: declaration.path,
        });
      }
      const status: ConventionExecutableStatus =
        invalidVersions.length > 0 ? "invalid" : declarations.length > 0 ? "adopted" : "missing";
      if (status === "missing") {
        diagnostics.push({
          code: "foundation-convention-tool-missing",
          message: `${name} is required by installed convention rules ${[...rules].sort().join(", ")} but has no repository-owned dependency declaration`,
        });
      }
      return {
        name,
        rules: [...rules].sort(),
        status,
        declarations,
      };
    });

  const status: ConventionExecutableStatus =
    inspection.diagnostics.length > 0 ||
    requiredExecutables.some((entry) => entry.status === "invalid")
      ? "invalid"
      : requiredExecutables.some((entry) => entry.status === "missing")
        ? "missing"
        : "adopted";
  return { status, diagnostics, requiredExecutables };
}

function conventionsAudit(root: string): FoundationComponent {
  const manifestPresent = existsSync(join(root, "conventions.json"));
  const lockPresent = existsSync(join(root, "conventions.lock.json"));
  const snapshotPresent = existsSync(join(root, ".conventions"));
  if (!manifestPresent && !lockPresent && !snapshotPresent) {
    return component("missing", [], { manifestPresent, lockPresent, snapshotPresent });
  }
  if (!(manifestPresent && lockPresent && snapshotPresent)) {
    return component(
      "invalid",
      [
        {
          code: "foundation-conventions-partial",
          message: "Convention manifest, lock, and managed snapshot must be adopted together",
        },
      ],
      { manifestPresent, lockPresent, snapshotPresent },
    );
  }

  const check = conventionRegistryCommand("check", [], { root });
  const executableTooling = check.status === "passed" ? conventionExecutableAudit(root) : undefined;
  const diagnostics = [...check.diagnostics, ...(executableTooling?.diagnostics ?? [])];
  return component(
    check.status === "passed" && executableTooling?.status === "adopted" ? "adopted" : "invalid",
    diagnostics,
    {
      manifestPresent,
      lockPresent,
      snapshotPresent,
      requestedModules: check.data.requestedModules ?? [],
      resolvedModules: check.data.resolvedModules ?? [],
      sourceRevision: check.data.sourceRevision,
      drift: check.data.drift ?? [],
      executableTooling,
    },
  );
}

function toolingAudit(root: string): { component: FoundationComponent; config?: ToolingConfig } {
  const configPath = join(root, ".coding-tooling.json");
  if (!existsSync(configPath)) {
    return {
      component: component("missing", [], { configPath: ".coding-tooling.json" }),
    };
  }
  try {
    const config = loadConfig(root);
    return {
      component: component("adopted", [], {
        configPath: ".coding-tooling.json",
        profile: config.profile,
        requiredCapabilities: [...(config.requiredCapabilities ?? [])].sort(),
        optionalCapabilities: [...(config.optionalCapabilities ?? [])].sort(),
      }),
      config,
    };
  } catch (error) {
    return {
      component: component("invalid", [
        {
          code: "foundation-tooling-config-invalid",
          message: error instanceof Error ? error.message : String(error),
          path: ".coding-tooling.json",
        },
      ]),
    };
  }
}

function commandInventory(root: string, config: ToolingConfig | undefined): FoundationComponent {
  if (!config) return component("missing");
  const components = discoverComponents(root);
  if (components.length === 0) {
    return component("unsupported", [
      {
        code: "foundation-components-unsupported",
        message: "No supported repository components were discovered",
      },
    ]);
  }

  const commands: CommandRecord[] = [];
  for (const discovered of components) {
    for (const [capability, discoveredCommand] of Object.entries(discovered.capabilities)) {
      if (!discoveredCommand) continue;
      const configured =
        config.capabilityCommands?.[discovered.name]?.[capability as Capability] ??
        config.capabilityCommands?.[discovered.path]?.[capability as Capability];
      commands.push({
        component: discovered.name,
        path: discovered.path,
        capability: capability as Capability,
        command: [...(configured ?? discoveredCommand)],
        source: configured ? "configured" : "discovered",
      });
    }
    for (const [selector, configuredCapabilities] of Object.entries(
      config.capabilityCommands ?? {},
    )) {
      if (selector !== discovered.name && selector !== discovered.path) continue;
      for (const [capability, configured] of Object.entries(configuredCapabilities)) {
        if (
          !configured ||
          commands.some(
            (entry) =>
              entry.component === discovered.name &&
              entry.path === discovered.path &&
              entry.capability === capability,
          )
        )
          continue;
        commands.push({
          component: discovered.name,
          path: discovered.path,
          capability: capability as Capability,
          command: [...configured],
          source: "configured",
        });
      }
    }
  }

  commands.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.component.localeCompare(right.component) ||
      left.capability.localeCompare(right.capability),
  );
  const availableCapabilities = new Set(commands.map((entry) => entry.capability));
  const missingRequired = [...(config.requiredCapabilities ?? [])]
    .filter((capability) => !availableCapabilities.has(capability))
    .sort();
  const diagnostics = missingRequired.map((capability) => ({
    code: "foundation-required-capability-unresolved",
    message: `${capability} is required but has no repository-owned command`,
  }));
  return component(missingRequired.length > 0 ? "invalid" : "adopted", diagnostics, {
    commands,
    missingRequired,
  });
}

function renovateAudit(root: string): FoundationComponent {
  const recommendation = renovateFoundationRecommendation(root);
  const configPath = recommendation.existingConfigPath;
  if (!configPath) {
    return component("missing", [], {
      configPath: recommendation.configPath,
      dependabotConfigPath: recommendation.dependabotConfigPath,
      preset: RENOVATE_PRESET,
    });
  }

  if (
    renovateUnsupportedExtensions.some(
      (extension) => configPath.endsWith(extension) || configPath === extension,
    )
  ) {
    return component(
      "unsupported",
      [
        {
          code: "foundation-renovate-format-unsupported",
          message: `${configPath} cannot be audited without executing a non-JSON config parser`,
          path: configPath,
        },
      ],
      { configPath, preset: RENOVATE_PRESET },
    );
  }

  let value: unknown;
  if (configPath === "package.json") {
    value = readJson<PackageManifest>(join(root, configPath))?.renovate;
  } else {
    value = readJson<unknown>(join(root, configPath));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return component("invalid", [
      {
        code: "foundation-renovate-config-invalid",
        message: `${configPath} is missing a valid JSON Renovate object`,
        path: configPath,
      },
    ]);
  }

  const extendsValue = (value as { extends?: unknown }).extends;
  if (
    !Array.isArray(extendsValue) ||
    extendsValue.some((entry) => typeof entry !== "string") ||
    !extendsValue.includes(RENOVATE_PRESET)
  ) {
    return component("invalid", [
      {
        code: "foundation-renovate-preset-missing",
        message: `${configPath} must extend ${RENOVATE_PRESET}`,
        path: configPath,
      },
    ]);
  }

  return component("adopted", [], {
    configPath,
    preset: RENOVATE_PRESET,
    extends: [...extendsValue],
    dependabotConfigPath: recommendation.dependabotConfigPath,
  });
}

function resultStatus(components: FoundationComponent[]): ResultStatus {
  if (components.some((entry) => entry.status === "invalid")) return "failed";
  if (components.some((entry) => entry.status === "unsupported")) return "unavailable";
  if (components.some((entry) => entry.status === "missing")) return "failed";
  return "passed";
}

export function foundationAudit(root = repositoryRoot()): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const resolvedRoot = resolve(root);
  try {
    const tooling = toolingAudit(resolvedRoot);
    const components = {
      environment: environmentAudit(resolvedRoot),
      tooling: tooling.component,
      commands: commandInventory(resolvedRoot, tooling.config),
      conventions: conventionsAudit(resolvedRoot),
      renovate: renovateAudit(resolvedRoot),
    };
    const values = Object.values(components);
    const diagnostics = values.flatMap((entry) => entry.diagnostics);
    return {
      schemaVersion: 1,
      operation: "foundation",
      status: resultStatus(values),
      durationMs: Date.now() - started,
      data: {
        reportVersion: 1,
        root: resolvedRoot,
        repositoryName: basename(resolvedRoot),
        components,
        summary: {
          adopted: values.filter((entry) => entry.status === "adopted").length,
          missing: values.filter((entry) => entry.status === "missing").length,
          invalid: values.filter((entry) => entry.status === "invalid").length,
          unsupported: values.filter((entry) => entry.status === "unsupported").length,
        },
      },
      diagnostics,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "foundation",
      status: "error",
      durationMs: Date.now() - started,
      data: {
        reportVersion: 1,
        root: resolvedRoot,
        repositoryName: basename(resolvedRoot),
      },
      diagnostics: [
        {
          code: "foundation-audit-error",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
