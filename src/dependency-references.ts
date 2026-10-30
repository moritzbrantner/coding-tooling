import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { walkFiles } from "./shared.ts";

/** A declared dependency with no source, script or config reference in its declaring package. */
export type UnusedDependencyCandidate = {
  component: string;
  name: string;
  kind: string;
  declaration: string;
};

type DeclaredDependency = { name: string; kind: string; declaration: string };

const javascriptSourceExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".html",
]);
const specifierPattern =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+|@import\s+|<reference\s+types=)["']([^"'\s]+)["']/g;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function packageRoot(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":"))
    return undefined;
  const parts = specifier.replace(/^~/, "").split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function byDeclaration(
  dependencies: readonly DeclaredDependency[],
): Map<string, DeclaredDependency[]> {
  const groups = new Map<string, DeclaredDependency[]>();
  for (const dependency of dependencies)
    groups.set(dependency.declaration, [...(groups.get(dependency.declaration) ?? []), dependency]);
  return groups;
}

function candidate(component: string, dependency: DeclaredDependency): UnusedDependencyCandidate {
  const { name, kind, declaration } = dependency;
  return { component, name, kind, declaration };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Config files and CI text can name a package (plugins, presets, CLIs) without importing it. */
function isConfigText(path: string): boolean {
  const name = basename(path);
  return (
    /\.config\.[cm]?[jt]s$|\.config\.json$/.test(name) ||
    /^\.[\w-]+rc(?:\.[\w]+)?$/.test(name) ||
    /^tsconfig.*\.json$/.test(name) ||
    /\.ya?ml$/.test(name) ||
    /\.(?:sh|bash)$/.test(name)
  );
}

type InstalledManifest = { bin?: unknown; peerDependencies?: unknown };

/** The installed package manifest, resolved like Node from the scope up to the repository root. */
function installedManifest(root: string, scope: string, name: string): InstalledManifest {
  for (let directory = scope; ; directory = dirname(directory)) {
    const text = readText(join(directory, "node_modules", name, "package.json"));
    if (text) {
      try {
        return JSON.parse(text) as InstalledManifest;
      } catch {
        return {};
      }
    }
    if (directory === root || directory === dirname(directory)) return {};
  }
}

function binNames(manifest: InstalledManifest, name: string): string[] {
  const names = [name.split("/").at(-1)!];
  if (typeof manifest.bin === "object" && manifest.bin) names.push(...Object.keys(manifest.bin));
  return names;
}

function javascriptCandidates(
  root: string,
  component: string,
  dependencies: readonly DeclaredDependency[],
): UnusedDependencyCandidate[] {
  const candidates: UnusedDependencyCandidate[] = [];
  for (const [declaration, declared] of byDeclaration(dependencies)) {
    const scope = join(root, dirname(declaration));
    const files = walkFiles(scope, 10);
    const imported = new Set<string>();
    const texts: string[] = [];
    for (const file of files) {
      if (javascriptSourceExtensions.has(extname(file))) {
        for (const match of readText(file).matchAll(specifierPattern)) {
          const name = packageRoot(match[1]!);
          if (name) imported.add(name);
        }
      }
      if (isConfigText(file)) texts.push(readText(file));
    }
    // The manifest's own non-dependency fields (scripts, prettier, eslintConfig, ...) count too.
    const manifest = JSON.parse(readText(join(root, declaration))) as Record<string, unknown>;
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      delete manifest[section];
    texts.push(JSON.stringify(manifest));
    const text = texts.join("\n");
    const installed = new Map(
      declared.map((dependency) => [
        dependency.name,
        installedManifest(root, scope, dependency.name),
      ]),
    );
    // A package another declared dependency lists as a peer is consumed through that dependency.
    const requiredPeers = new Set(
      [...installed.values()].flatMap((dependencyManifest) =>
        dependencyManifest.peerDependencies &&
        typeof dependencyManifest.peerDependencies === "object"
          ? Object.keys(dependencyManifest.peerDependencies)
          : [],
      ),
    );
    const typescriptProject = files.some((file) => /^tsconfig.*\.json$/.test(basename(file)));

    for (const dependency of declared) {
      // Peer and ambient type packages are consumed implicitly.
      if (dependency.kind === "peer" || dependency.name.startsWith("@types/")) continue;
      if (imported.has(dependency.name) || requiredPeers.has(dependency.name)) continue;
      if (dependency.name === "typescript" && typescriptProject) continue;
      const tokens = [
        dependency.name,
        ...binNames(installed.get(dependency.name) ?? {}, dependency.name),
      ];
      const named = tokens.some((token) =>
        new RegExp(`(?:^|[^\\w@/.-]|node_modules/)${escapeRegex(token)}(?:$|[^\\w-])`, "m").test(
          text,
        ),
      );
      if (!named) candidates.push(candidate(component, dependency));
    }
  }
  return candidates;
}

function rustCandidates(
  root: string,
  component: string,
  dependencies: readonly DeclaredDependency[],
): UnusedDependencyCandidate[] {
  const candidates: UnusedDependencyCandidate[] = [];
  for (const [declaration, declared] of byDeclaration(dependencies)) {
    const scope = join(root, dirname(declaration));
    const source = walkFiles(scope, 10, { includeIgnoredDirectories: ["bin"] })
      .filter((file) => extname(file) === ".rs")
      .map(readText)
      .join("\n");
    for (const dependency of declared) {
      const identifier = escapeRegex(dependency.name.replace(/-/g, "_"));
      const pattern = new RegExp(
        `\\b${identifier}\\s*::|\\bextern\\s+crate\\s+${identifier}\\b|\\buse\\s+${identifier}\\b`,
      );
      if (!pattern.test(source)) candidates.push(candidate(component, dependency));
    }
  }
  return candidates;
}

/**
 * Declared dependencies that nothing in the declaring package references: no import/`use`
 * specifier, script, CLI binary or config mention. These are candidates, not proof; dynamic
 * loading and naming conventions can hide a real use.
 */
export function unusedDependencyCandidates(
  root: string,
  component: { id: string; ecosystem: string; dependencies: readonly DeclaredDependency[] },
): UnusedDependencyCandidate[] {
  if (component.ecosystem === "javascript")
    return javascriptCandidates(root, component.id, component.dependencies);
  if (component.ecosystem === "rust")
    return rustCandidates(root, component.id, component.dependencies);
  return [];
}
