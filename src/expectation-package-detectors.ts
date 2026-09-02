import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverComponents, loadConfig } from "./core.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import type { DetectorContext, PackageManifest } from "./expectation-package-context.ts";
import type { Capability } from "./model.ts";
import { relativePosix } from "./shared.ts";

export function missingAggregateCheckFindings({ root, packages }: DetectorContext): RawFinding[] {
  const candidates = ["format:check", "lint", "typecheck", "test", "test:unit", "build"];
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    const scripts = packageInfo.manifest.scripts ?? {};
    const available = candidates.filter((name) => typeof scripts[name] === "string");
    if (
      available.length < 2 ||
      typeof scripts.check === "string" ||
      typeof scripts.verify === "string"
    ) {
      continue;
    }
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    findings.push({
      subject: {
        kind: "package",
        key: packageInfo.path,
        path: manifestPath,
        description: `package ${packageInfo.manifest.name ?? packageInfo.path}`,
      },
      requirement: {
        kind: "check",
        key: "package.json#scripts.check",
        description: "an aggregate check or verify script",
        expectedArtifact: `${manifestPath}#scripts.check`,
      },
      message: `${manifestPath} exposes ${available.length} verification scripts but no aggregate check/verify script`,
      evidence: [
        {
          kind: "manifest",
          path: manifestPath,
          detail: `verification scripts: ${available.sort().join(", ")}`,
        },
      ],
      relatedFiles: [manifestPath],
      verification: packageInfo.usesBun ? [["bun", "run", "check"]] : [["npm", "run", "check"]],
    });
  }
  return findings;
}

export function missingTypeScriptConfigFindings({ root, packages }: DetectorContext): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    if (
      packageInfo.sourceFiles.length === 0 ||
      existsSync(join(packageInfo.directory, "tsconfig.json"))
    ) {
      continue;
    }
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    const target = relativePosix(root, join(packageInfo.directory, "tsconfig.json"));
    findings.push({
      subject: {
        kind: "package",
        key: packageInfo.path,
        path: manifestPath,
        description: `TypeScript package ${packageInfo.manifest.name ?? packageInfo.path}`,
      },
      requirement: {
        kind: "file",
        key: target,
        description: "a TypeScript project configuration",
        expectedArtifact: target,
      },
      message: `${packageInfo.path} contains TypeScript source but no tsconfig.json`,
      evidence: packageInfo.sourceFiles.slice(0, 3).map((path) => ({
        kind: "file" as const,
        path: relativePosix(root, path),
        detail: "TypeScript source exists",
      })),
      relatedFiles: [
        manifestPath,
        ...packageInfo.sourceFiles.slice(0, 3).map((path) => relativePosix(root, path)),
      ],
      verification:
        typeof packageInfo.manifest.scripts?.typecheck === "string"
          ? [packageInfo.usesBun ? ["bun", "run", "typecheck"] : ["npm", "run", "typecheck"]]
          : [],
    });
  }
  return findings;
}

function normalizedBinTargets(bin: PackageManifest["bin"]): string[] {
  const values = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/^\.\//, "").replaceAll("\\", "/"));
}

export function missingCliWiringFindings({ root, packages }: DetectorContext): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    const targets = normalizedBinTargets(packageInfo.manifest.bin);
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    if (targets.length > 0) {
      for (const target of targets) {
        if (existsSync(join(packageInfo.directory, target))) continue;
        findings.push({
          subject: {
            kind: "package",
            key: packageInfo.path,
            path: manifestPath,
            description: `package ${packageInfo.manifest.name ?? packageInfo.path}`,
          },
          requirement: {
            kind: "wiring",
            key: `${manifestPath}#bin:${target}`,
            description: "a bin target that resolves to an existing file",
            expectedArtifact: relativePosix(root, join(packageInfo.directory, target)),
          },
          message: `${manifestPath} wires bin target ${target}, but that file does not exist`,
          evidence: [{ kind: "manifest", path: manifestPath, detail: `bin references ${target}` }],
          relatedFiles: [manifestPath],
          verification: [],
        });
      }
      continue;
    }

    const cli = join(packageInfo.directory, "src", "cli.ts");
    if (!existsSync(cli)) continue;
    const cliPath = relativePosix(root, cli);
    findings.push({
      subject: {
        kind: "file",
        key: cliPath,
        path: cliPath,
        description: `CLI entrypoint ${cliPath}`,
      },
      requirement: {
        kind: "wiring",
        key: `${manifestPath}#bin`,
        description: "package.json bin wiring for the CLI entrypoint",
        expectedArtifact: `${manifestPath}#bin`,
      },
      message: `${cliPath} exists but package.json has no bin wiring`,
      evidence: [
        { kind: "file", path: cliPath, detail: "CLI entrypoint exists" },
        { kind: "manifest", path: manifestPath, detail: "bin is not configured" },
      ],
      relatedFiles: [cliPath, manifestPath],
      verification: [],
    });
  }
  return findings;
}

export function missingRequiredCapabilityFindings({ root }: DetectorContext): RawFinding[] {
  if (!existsSync(join(root, ".coding-tooling.json"))) return [];
  const config = loadConfig(root);
  const required = config.requiredCapabilities ?? [];
  if (required.length === 0) return [];
  const components = discoverComponents(root);
  const available = new Set<Capability>();
  for (const component of components) {
    const configured = {
      ...component.capabilities,
      ...config.capabilityCommands?.[component.name],
      ...config.capabilityCommands?.[component.path],
    };
    for (const capability of Object.keys(configured) as Capability[]) {
      if (configured[capability]) available.add(capability);
    }
  }

  const configPath = ".coding-tooling.json";
  return required
    .filter((capability) => !available.has(capability))
    .map((capability) => ({
      subject: {
        kind: "repository" as const,
        key: ".",
        path: configPath,
        description: "repository verification contract",
      },
      requirement: {
        kind: "signal" as const,
        key: capability,
        description: `configured required capability ${capability}`,
        expectedArtifact: configPath,
      },
      message: `required capability ${capability} is configured but no component provides it`,
      evidence: [
        {
          kind: "config" as const,
          path: configPath,
          detail: `${capability} is listed in requiredCapabilities`,
        },
      ],
      relatedFiles: [configPath],
      verification: [],
    }));
}
