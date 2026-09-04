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
import { readJson, repositoryRoot } from "./shared.ts";

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

type PackageManifest = {
  packageManager?: unknown;
  renovate?: unknown;
};

const renovateUnsupportedExtensions = [".jsonc", ".json5", ".renovaterc"] as const;

function exactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function text(path: string): string {
  return readFileSync(path, "utf8");
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
  if (
    typeof packageManifest?.packageManager === "string" &&
    packageManifest.packageManager.startsWith("bun@")
  ) {
    declarations.push({
      tool: "bun",
      path: "package.json",
      version: packageManifest.packageManager.slice("bun@".length),
    });
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
  return component(check.status === "passed" ? "adopted" : "invalid", check.diagnostics, {
    manifestPresent,
    lockPresent,
    snapshotPresent,
    requestedModules: check.data.requestedModules ?? [],
    resolvedModules: check.data.resolvedModules ?? [],
    sourceRevision: check.data.sourceRevision,
    drift: check.data.drift ?? [],
  });
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
