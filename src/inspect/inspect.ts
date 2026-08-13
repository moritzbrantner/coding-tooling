import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getProfile } from "../profiles/index.ts";
import { capabilityOrder, type Component, type Inspection } from "../types.ts";
import {
  findRepositoryRoot,
  hasAnyFile,
  hasDotnetProject,
  listDirectories,
} from "../shared/paths.ts";

interface PackageJson {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPackageJson(directory: string): PackageJson | null {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

function availableCapabilities(profileId: string, directory: string): Component["capabilities"] {
  const profile = getProfile(profileId);
  const pkg = readPackageJson(directory);

  return capabilityOrder.filter((capability) => {
    const definition = profile.capabilities[capability];
    if (!definition) return false;
    if (!definition.requires_script) return true;
    return Boolean(pkg?.scripts?.[definition.requires_script]);
  });
}

function detectProfile(directory: string, repositoryRoot: string): string[] {
  const detected: string[] = [];
  const pkg = readPackageJson(directory);

  if (pkg) {
    const deps = dependencyNames(pkg);
    const bun =
      pkg.packageManager?.startsWith("bun@") ||
      hasAnyFile(directory, ["bun.lock", "bun.lockb"]) ||
      (directory !== repositoryRoot && hasAnyFile(repositoryRoot, ["bun.lock", "bun.lockb"]));

    if (bun && deps.has("react") && deps.has("vite")) {
      detected.push("react-vite");
    } else if (bun && (deps.has("typescript") || existsSync(join(directory, "tsconfig.json")))) {
      detected.push("bun-typescript");
    }
  }

  if (existsSync(join(directory, "Cargo.toml"))) detected.push("rust");
  if (hasDotnetProject(directory)) detected.push("dotnet");

  return detected;
}

function componentName(repositoryRoot: string, directory: string, profileId: string): string {
  const rel = relative(repositoryRoot, directory);
  const base = rel === "" ? "root" : rel.replaceAll("\\", "/");
  return `${base}:${profileId}`;
}

export function inspectRepository(start = process.cwd()): Inspection {
  const root = findRepositoryRoot(start) ?? start;
  const components: Component[] = [];

  for (const directory of listDirectories(root, 2)) {
    for (const profileId of detectProfile(directory, root)) {
      const profile = getProfile(profileId);
      components.push({
        name: componentName(root, directory, profileId),
        path: relative(root, directory).replaceAll("\\", "/") || ".",
        profile: profile.id,
        language: profile.language,
        runtime: profile.runtime,
        capabilities: availableCapabilities(profileId, directory),
      });
    }
  }

  components.sort((a, b) => a.name.localeCompare(b.name));
  const languages = [...new Set(components.map((component) => component.language))].sort();
  const runtimes = [...new Set(components.map((component) => component.runtime))].sort();
  const profiles = [...new Set(components.map((component) => component.profile))].sort();

  const capabilities = Object.fromEntries(
    capabilityOrder.map((capability) => [
      capability,
      components.some((component) => component.capabilities.includes(capability)),
    ]),
  ) as Inspection["capabilities"];

  return {
    schemaVersion: 1,
    root,
    languages,
    runtimes,
    profiles,
    capabilities,
    components,
  };
}
