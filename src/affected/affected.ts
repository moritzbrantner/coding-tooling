import { inspectRepository } from "../inspect/inspect.ts";
import { runCommand } from "../shared/command.ts";
import { capabilityOrder, type AffectedResult, type Capability, type Component } from "../types.ts";

export function recommendCapabilities(files: string[]): Capability[] {
  const recommended = new Set<Capability>();
  const broadConfig = new Set([
    "package.json",
    "bun.lock",
    "bun.lockb",
    "Cargo.toml",
    "Cargo.lock",
    "Directory.Build.props",
    "Directory.Build.targets",
  ]);

  for (const file of files) {
    const name = file.split("/").at(-1) ?? file;
    if (broadConfig.has(name)) {
      capabilityOrder.forEach((capability) => recommended.add(capability));
      continue;
    }

    if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(file)) {
      ["format", "lint", "typecheck", "test:unit"].forEach((capability) =>
        recommended.add(capability as Capability),
      );
    } else if (file.endsWith(".rs")) {
      ["format", "lint", "typecheck", "test:unit"].forEach((capability) =>
        recommended.add(capability as Capability),
      );
    } else if (/\.(cs|csproj|sln|slnx)$/.test(file)) {
      ["format", "build", "test:unit"].forEach((capability) =>
        recommended.add(capability as Capability),
      );
    }
  }

  return capabilityOrder.filter((capability) => recommended.has(capability));
}

function changedFiles(root: string, base?: string): string[] {
  const command = base
    ? ["git", "diff", "--name-only", "--diff-filter=ACMRT", `${base}...HEAD`]
    : ["git", "diff", "--name-only", "--diff-filter=ACMRT", "HEAD~1...HEAD"];
  let result = runCommand(command, root);

  if (result.exitCode !== 0 && !base) {
    result = runCommand(["git", "status", "--porcelain=v1"], root);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .map((file) => file.split(" -> ").at(-1) ?? file)
      .map((file) => file.replaceAll("\\", "/"));
  }

  if (result.exitCode !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

function matchingComponents(files: string[], components: Component[]): Component[] {
  const matched = new Map<string, Component>();

  for (const file of files) {
    const candidates = components.filter((component) => {
      if (component.path === ".") return true;
      return file === component.path || file.startsWith(`${component.path}/`);
    });
    const maxDepth = Math.max(
      0,
      ...candidates.map((component) => component.path.split("/").length),
    );
    for (const component of candidates) {
      const depth = component.path === "." ? 0 : component.path.split("/").length;
      if (depth === maxDepth) matched.set(component.name, component);
    }
  }

  return [...matched.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function affectedRepository(start = process.cwd(), base?: string): AffectedResult {
  const inspection = inspectRepository(start);
  const files = changedFiles(inspection.root, base);
  const affected = matchingComponents(files, inspection.components);
  const suggested = recommendCapabilities(files);
  const available = new Set(affected.flatMap((component) => component.capabilities));
  const recommendedCapabilities = suggested.filter((capability) => available.has(capability));

  return {
    schemaVersion: 1,
    root: inspection.root,
    base: base ?? null,
    changedFiles: files,
    affectedComponents: affected.map((component) => component.name),
    recommendedCapabilities,
  };
}
