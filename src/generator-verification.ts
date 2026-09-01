import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { check, inspect } from "./core.ts";
import type { GeneratorPlan } from "./generators.ts";
import type { Capability, Diagnostic, ResultEnvelope } from "./model.ts";
import { commandAvailable, readJson } from "./shared.ts";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type InstalledConventions = {
  resolvedModules?: string[];
};

type PackagePrerequisite = {
  kind: "package";
  name: string;
  version?: string;
  range?: string;
};

type ConventionModulePrerequisite = {
  kind: "convention-module";
  name: string;
};

type TechnologyPrerequisite = {
  kind: "technology";
  name: string;
};

type ToolPrerequisite = {
  kind: "tool";
  name: string;
};

type FilePrerequisite = {
  kind: "file";
  path: string;
};

type NetworkPrerequisite = {
  kind: "native" | "dependency" | "network";
  network?: boolean;
  [key: string]: unknown;
};

type SupportedPrerequisite =
  | PackagePrerequisite
  | ConventionModulePrerequisite
  | TechnologyPrerequisite
  | ToolPrerequisite
  | FilePrerequisite
  | NetworkPrerequisite;

export type PrerequisiteCheck = {
  kind: string;
  name?: string;
  status: "passed" | "failed";
  code?: string;
  message: string;
  evidence?: Record<string, unknown>;
};

export type PrerequisiteEvaluation = {
  status: "passed" | "failed";
  checks: PrerequisiteCheck[];
  diagnostics: Diagnostic[];
};

export type PostconditionCheck = {
  capability: Capability;
  status: ResultEnvelope<Record<string, unknown>>["status"];
  component?: string;
  durationMs: number;
  diagnostics: Diagnostic[];
};

export type PostconditionEvaluation = {
  status: "passed" | "failed";
  checks: PostconditionCheck[];
  diagnostics: Diagnostic[];
};

export type CapabilityChecker = (
  root: string,
  capability: Capability,
  component?: string,
) => ResultEnvelope<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function packageRoot(root: string, target: string): string | undefined {
  const absoluteRoot = resolve(root);
  let current = resolve(absoluteRoot, target === "." ? "" : target);
  while (withinRoot(absoluteRoot, current)) {
    if (existsSync(join(current, "package.json"))) return current;
    if (current === absoluteRoot) break;
    current = dirname(current);
  }
  return undefined;
}

function packageDeclaration(manifest: PackageManifest, name: string): string | undefined {
  return (
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.optionalDependencies?.[name] ??
    manifest.peerDependencies?.[name]
  );
}

function installedPackageVersion(packageDirectory: string, name: string): string | undefined {
  const manifestPath = join(packageDirectory, "node_modules", ...name.split("/"), "package.json");
  const manifest = readJson<{ version?: string }>(manifestPath);
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

function packageVersionMatches(
  prerequisite: PackagePrerequisite,
  declared: string | undefined,
  installed: string | undefined,
): boolean {
  if (!prerequisite.version && !prerequisite.range) return true;
  if (prerequisite.version) {
    return installed === prerequisite.version || declared === prerequisite.version;
  }
  const range = prerequisite.range!;
  if (declared === range) return true;
  if (!installed) return false;
  try {
    return Bun.semver.satisfies(installed, range);
  } catch {
    return false;
  }
}

function packageCheck(
  root: string,
  target: string,
  prerequisite: PackagePrerequisite,
): PrerequisiteCheck {
  if (!prerequisite.name) {
    return {
      kind: prerequisite.kind,
      status: "failed",
      code: "invalid-generator-prerequisite",
      message: "Package prerequisite is missing a package name.",
    };
  }
  const directory = packageRoot(root, target);
  if (!directory) {
    return {
      kind: prerequisite.kind,
      name: prerequisite.name,
      status: "failed",
      code: "package-manifest-unavailable",
      message: `No package.json is available for generator target ${target}.`,
    };
  }
  const manifest = readJson<PackageManifest>(join(directory, "package.json")) ?? {};
  const declared = packageDeclaration(manifest, prerequisite.name);
  const installed = installedPackageVersion(directory, prerequisite.name);
  if (!declared && !installed) {
    return {
      kind: prerequisite.kind,
      name: prerequisite.name,
      status: "failed",
      code: "network-required",
      message: `Package ${prerequisite.name} is not present locally; generation will not fetch it implicitly.`,
      evidence: { packageRoot: directory },
    };
  }
  if (!packageVersionMatches(prerequisite, declared, installed)) {
    return {
      kind: prerequisite.kind,
      name: prerequisite.name,
      status: "failed",
      code: "package-version-mismatch",
      message: `Package ${prerequisite.name} does not satisfy the declared generator prerequisite.`,
      evidence: {
        declared,
        installed,
        requiredVersion: prerequisite.version,
        requiredRange: prerequisite.range,
      },
    };
  }
  return {
    kind: prerequisite.kind,
    name: prerequisite.name,
    status: "passed",
    message: `Package prerequisite ${prerequisite.name} is satisfied.`,
    evidence: { declared, installed, packageRoot: directory },
  };
}

function moduleCheck(root: string, prerequisite: ConventionModulePrerequisite): PrerequisiteCheck {
  const lock = readJson<InstalledConventions>(join(root, "conventions.lock.json"));
  const installed = lock?.resolvedModules ?? [];
  const passed = installed.includes(prerequisite.name);
  return {
    kind: prerequisite.kind,
    name: prerequisite.name,
    status: passed ? "passed" : "failed",
    code: passed ? undefined : "missing-convention-module",
    message: passed
      ? `Convention module ${prerequisite.name} is installed.`
      : `Convention module ${prerequisite.name} is not installed.`,
    evidence: { installedModules: installed },
  };
}

function technologyCheck(root: string, prerequisite: TechnologyPrerequisite): PrerequisiteCheck {
  const repository = inspect(root);
  const technologies = Array.isArray(repository.data.technologies)
    ? repository.data.technologies.filter((item): item is string => typeof item === "string")
    : [];
  const passed = technologies.includes(prerequisite.name);
  return {
    kind: prerequisite.kind,
    name: prerequisite.name,
    status: passed ? "passed" : "failed",
    code: passed ? undefined : "missing-technology",
    message: passed
      ? `Technology ${prerequisite.name} is present.`
      : `Technology ${prerequisite.name} is not present.`,
    evidence: { technologies },
  };
}

function toolCheck(prerequisite: ToolPrerequisite): PrerequisiteCheck {
  const passed = Boolean(prerequisite.name) && commandAvailable(prerequisite.name);
  return {
    kind: prerequisite.kind,
    name: prerequisite.name,
    status: passed ? "passed" : "failed",
    code: passed ? undefined : "missing-tool",
    message: passed
      ? `Tool ${prerequisite.name} is available.`
      : `Tool ${prerequisite.name} is not available locally.`,
  };
}

function fileCheck(root: string, prerequisite: FilePrerequisite): PrerequisiteCheck {
  if (!prerequisite.path) {
    return {
      kind: prerequisite.kind,
      status: "failed",
      code: "invalid-generator-prerequisite",
      message: "File prerequisite is missing a path.",
    };
  }
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, prerequisite.path);
  if (!withinRoot(absoluteRoot, candidate)) {
    return {
      kind: prerequisite.kind,
      status: "failed",
      code: "invalid-generator-prerequisite",
      message: `File prerequisite escapes repository root: ${prerequisite.path}`,
    };
  }
  if (!existsSync(candidate)) {
    return {
      kind: prerequisite.kind,
      status: "failed",
      code: "missing-generator-file",
      message: `Required generator file is missing: ${prerequisite.path}`,
    };
  }
  try {
    const realRoot = realpathSync(absoluteRoot);
    const realCandidate = realpathSync(candidate);
    if (!withinRoot(realRoot, realCandidate) || !statSync(realCandidate).isFile()) {
      return {
        kind: prerequisite.kind,
        status: "failed",
        code: "invalid-generator-prerequisite",
        message: `Required generator path is not a repository file: ${prerequisite.path}`,
      };
    }
  } catch {
    return {
      kind: prerequisite.kind,
      status: "failed",
      code: "invalid-generator-prerequisite",
      message: `Required generator path is not a readable file: ${prerequisite.path}`,
    };
  }
  return {
    kind: prerequisite.kind,
    name: prerequisite.path,
    status: "passed",
    message: `File prerequisite ${prerequisite.path} is satisfied.`,
    evidence: { path: prerequisite.path },
  };
}

function prerequisiteCheck(root: string, plan: GeneratorPlan, raw: unknown): PrerequisiteCheck {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return {
      kind: "unknown",
      status: "failed",
      code: "invalid-generator-prerequisite",
      message: "Generator prerequisite metadata is invalid.",
    };
  }
  const prerequisite = raw as SupportedPrerequisite;
  if (prerequisite.kind === "package") return packageCheck(root, plan.target, prerequisite);
  if (prerequisite.kind === "convention-module") return moduleCheck(root, prerequisite);
  if (prerequisite.kind === "technology") return technologyCheck(root, prerequisite);
  if (prerequisite.kind === "tool") return toolCheck(prerequisite);
  if (prerequisite.kind === "file") return fileCheck(root, prerequisite);
  if (
    prerequisite.kind === "network" ||
    prerequisite.kind === "native" ||
    prerequisite.kind === "dependency"
  ) {
    return {
      kind: prerequisite.kind,
      status: "failed",
      code: "network-required",
      message:
        "This prerequisite requires an allowlisted native/dependency adapter; v1 generation will not execute or fetch it implicitly.",
    };
  }
  return {
    kind: prerequisite.kind,
    status: "failed",
    code: "unsupported-generator-prerequisite",
    message: `Unsupported generator prerequisite kind: ${prerequisite.kind}`,
  };
}

export function evaluateGeneratorPrerequisites(
  root: string,
  plan: GeneratorPlan,
): PrerequisiteEvaluation {
  const checks: PrerequisiteCheck[] = [];
  for (const prerequisite of plan.prerequisites) {
    const result = prerequisiteCheck(root, plan, prerequisite);
    checks.push(result);
    if (result.status !== "passed") break;
  }
  const diagnostics = checks
    .filter((item) => item.status !== "passed")
    .map((item) => ({ code: item.code, message: item.message }));
  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    checks,
    diagnostics,
  };
}

type ComponentView = {
  path?: unknown;
  name?: unknown;
};

function targetComponent(root: string, target: string): string | undefined {
  const repository = inspect(root);
  const components = Array.isArray(repository.data.components)
    ? (repository.data.components as ComponentView[])
    : [];
  const normalizedTarget = target === "." ? "" : target.replaceAll("\\", "/").replace(/^\.\//, "");
  const candidates = components
    .filter((component) => typeof component.path === "string")
    .map((component) => ({
      path: component.path as string,
      name: typeof component.name === "string" ? component.name : undefined,
    }))
    .filter(({ path }) => {
      if (path === ".") return true;
      return normalizedTarget === path || normalizedTarget.startsWith(`${path}/`);
    })
    .sort((left, right) => right.path.length - left.path.length);
  return candidates[0]?.path ?? candidates[0]?.name;
}

export function verifyGeneratorPostconditions(
  root: string,
  plan: GeneratorPlan,
  checker: CapabilityChecker = check,
): PostconditionEvaluation {
  const checks: PostconditionCheck[] = [];
  const component = targetComponent(root, plan.target);
  for (const capability of plan.postconditions) {
    const result = checker(root, capability, component);
    checks.push({
      capability,
      status: result.status,
      component,
      durationMs: result.durationMs,
      diagnostics: result.diagnostics,
    });
    if (result.status !== "passed") break;
  }
  const diagnostics = checks
    .filter((item) => item.status !== "passed")
    .flatMap((item) => [
      {
        code: "generated-but-unverified",
        message: `Generated scaffold failed postcondition ${item.capability} with status ${item.status}.`,
      },
      ...item.diagnostics,
    ]);
  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    checks,
    diagnostics,
  };
}
