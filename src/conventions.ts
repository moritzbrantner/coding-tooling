import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { discoverComponents, loadConfig } from "./core.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readJson, repositoryRoot, runCommand, walkFiles } from "./shared.ts";

type ConventionResolutionOptions = {
  root?: string;
  configPath?: string;
  conventionsRoot?: string;
  registryPath?: string;
};

type ConventionSource = {
  root: string;
  source: "explicit" | "environment" | "registry" | "sibling";
};

type ConventionFile = {
  path: string;
  absolutePath: string;
  reason: "principle" | "general" | "technology" | "explicit-ref";
};

type PackageManifest = {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const technologyConventionPaths: Record<string, string> = {
  rust: "technologies/rust/README.md",
  typescript: "technologies/typescript/README.md",
  react: "technologies/typescript/react/README.md",
  nextjs: "technologies/typescript/react/nextjs/README.md",
  "moritzbrantner-ui": "technologies/typescript/react/moritzbrantner-ui/README.md",
  "react-hook-form": "technologies/typescript/react/react-hook-form/README.md",
  "tanstack-query": "technologies/typescript/react/tanstack-query/README.md",
  "testing-library": "technologies/typescript/react/testing-library/README.md",
  zustand: "technologies/typescript/react/zustand/README.md",
  tooling: "technologies/tooling/README.md",
  vite: "technologies/tooling/vite/README.md",
  vitest: "technologies/tooling/vitest/README.md",
  playwright: "technologies/tooling/playwright/README.md",
  storybook: "technologies/tooling/storybook/README.md",
  lighthouse: "technologies/tooling/lighthouse/README.md",
  databases: "technologies/databases/README.md",
  postgres: "technologies/databases/postgres/README.md",
  docker: "technologies/docker/README.md",
  dockerfile: "technologies/docker/dockerfile/README.md",
};

const dependencyTechnologies: Record<string, string> = {
  react: "react",
  next: "nextjs",
  vite: "vite",
  "@moritzbrantner/ui": "moritzbrantner-ui",
  "react-hook-form": "react-hook-form",
  "@tanstack/react-query": "tanstack-query",
  "@testing-library/react": "testing-library",
  zustand: "zustand",
  vitest: "vitest",
  "@playwright/test": "playwright",
  storybook: "storybook",
  "@storybook/react": "storybook",
  "@storybook/react-vite": "storybook",
  lighthouse: "lighthouse",
  "@lhci/cli": "lighthouse",
  pg: "postgres",
  postgres: "postgres",
  "@neondatabase/serverless": "postgres",
};

const toolingDependencies = new Set([
  "tailwindcss",
  "@tailwindcss/vite",
  "@tailwindcss/postcss",
  "oxfmt",
  "oxlint",
]);

function defaultRegistryPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "moenarch",
    "environment.toml",
  );
}

function validConventionsRoot(path: string): boolean {
  return (
    existsSync(join(path, "README.md")) &&
    existsSync(join(path, "principles")) &&
    existsSync(join(path, "conventions")) &&
    existsSync(join(path, "technologies"))
  );
}

function registryComponentPath(path: string, component: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const header = `[components.${component}]`;
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      active = trimmed === header;
      continue;
    }
    if (!active) continue;
    const match = trimmed.match(/^path\s*=\s*("(?:[^"\\]|\\.)*")\s*$/);
    if (match) {
      try {
        return JSON.parse(match[1]) as string;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function resolveConventionSource(
  options: ConventionResolutionOptions = {},
): ConventionSource | undefined {
  const root = resolve(options.root ?? repositoryRoot());
  const candidates: Array<ConventionSource | undefined> = [
    options.conventionsRoot
      ? { root: resolve(options.conventionsRoot), source: "explicit" }
      : undefined,
    process.env.CODING_AGENT_CONVENTIONS_ROOT
      ? { root: resolve(process.env.CODING_AGENT_CONVENTIONS_ROOT), source: "environment" }
      : undefined,
  ];
  const registered = registryComponentPath(
    resolve(options.registryPath ?? defaultRegistryPath()),
    "coding-agent-conventions",
  );
  if (registered) candidates.push({ root: resolve(registered), source: "registry" });
  candidates.push({ root: resolve(root, "..", "coding-agent-conventions"), source: "sibling" });
  return candidates.find((candidate) => candidate && validConventionsRoot(candidate.root));
}

function revision(root: string): string {
  const head = runCommand("git", ["rev-parse", "HEAD"], root);
  if (head.status !== 0 || !head.stdout.trim()) return "unversioned";
  const status = runCommand("git", ["status", "--porcelain"], root);
  const suffix = status.status === 0 && status.stdout.trim() ? "-dirty" : "";
  return `${head.stdout.trim()}${suffix}`;
}

function markdownFiles(root: string, directory: string): string[] {
  const path = join(root, directory);
  if (!existsSync(path)) return [];
  return walkFiles(path, 8)
    .filter((file) => file.endsWith(".md"))
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
}

function conventionIds(root: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of walkFiles(root, 10).filter((file) => file.endsWith(".md"))) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^##\s+([A-Z][A-Z0-9-]*-\d+)\b/gm)) {
      const id = match[1];
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const previous = index.get(id);
      if (previous && previous !== relativePath) {
        throw new Error(`Convention ID ${id} is defined in both ${previous} and ${relativePath}`);
      }
      index.set(id, relativePath);
    }
  }
  return index;
}

function repositoryTechnologies(root: string): string[] {
  const files = walkFiles(root, 4);
  const technologies = new Set(
    discoverComponents(root).flatMap((component) => component.technologies),
  );

  for (const file of files.filter((path) => basename(path) === "package.json")) {
    const manifest = readJson<PackageManifest>(file);
    if (!manifest) continue;
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const [dependency, technology] of Object.entries(dependencyTechnologies)) {
      if (dependency in dependencies) technologies.add(technology);
    }
    if (
      manifest.packageManager?.startsWith("bun@") ||
      Object.keys(dependencies).some((dependency) => toolingDependencies.has(dependency))
    ) {
      technologies.add("tooling");
    }
  }

  if (files.some((path) => basename(path) === "bun.lock" || basename(path) === "bun.lockb")) {
    technologies.add("tooling");
  }

  const hasDockerfile = files.some((path) => {
    const name = basename(path);
    return name === "Dockerfile" || name.startsWith("Dockerfile.");
  });
  const hasCompose = files.some((path) => {
    const name = basename(path);
    return (
      name === "docker-compose.yml" ||
      name === "docker-compose.yaml" ||
      name === "compose.yml" ||
      name === "compose.yaml"
    );
  });
  if (hasDockerfile || hasCompose) technologies.add("docker");
  if (hasDockerfile) technologies.add("dockerfile");

  if (technologies.has("postgres")) technologies.add("databases");
  if (
    [...technologies].some((technology) =>
      technologyConventionPaths[technology]?.startsWith("technologies/tooling/"),
    )
  ) {
    technologies.add("tooling");
  }

  return [...technologies].sort();
}

function localInstructionFiles(root: string): string[] {
  return walkFiles(root, 8)
    .filter((path) => {
      const name = basename(path);
      return name === "AGENTS.md" || name === "CLAUDE.md";
    })
    .toSorted((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function addFile(
  files: Map<string, ConventionFile>,
  conventionsRoot: string,
  path: string,
  reason: ConventionFile["reason"],
): void {
  const absolutePath = join(conventionsRoot, path);
  if (!existsSync(absolutePath)) return;
  const existing = files.get(path);
  if (!existing || existing.reason === "technology") {
    files.set(path, { path, absolutePath, reason });
  }
}

export function resolveConventions(
  options: ConventionResolutionOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? repositoryRoot());
  try {
    const source = resolveConventionSource({ ...options, root });
    if (!source) {
      return envelope(
        "unavailable",
        started,
        { root, files: [], technologies: repositoryTechnologies(root) },
        [
          {
            code: "conventions-source-unavailable",
            message:
              "coding-agent-conventions is not available; register it in the Moenarch environment, set CODING_AGENT_CONVENTIONS_ROOT, provide --conventions-root, or use a sibling checkout",
          },
        ],
      );
    }

    const config = loadConfig(root, options.configPath);
    const technologies = repositoryTechnologies(root);
    const files = new Map<string, ConventionFile>();

    for (const path of markdownFiles(source.root, "principles")) {
      addFile(files, source.root, path, "principle");
    }
    for (const path of markdownFiles(source.root, "conventions")) {
      addFile(files, source.root, path, "general");
    }

    for (const technology of technologies) {
      const path = technologyConventionPaths[technology];
      if (path) addFile(files, source.root, path, "technology");
    }

    const ids = conventionIds(source.root);
    const resolvedRefs: Record<string, string> = {};
    const missingRefs: string[] = [];
    for (const id of config.conventionRefs ?? []) {
      const path = ids.get(id);
      if (!path) {
        missingRefs.push(id);
        continue;
      }
      resolvedRefs[id] = path;
      addFile(files, source.root, path, "explicit-ref");
    }

    const selectedPaths = new Set(files.keys());
    const selectedConventionIds = [...ids.entries()]
      .filter(([, path]) => selectedPaths.has(path))
      .map(([id]) => id)
      .sort();
    const localInstructions = localInstructionFiles(root);
    const diagnostics: Diagnostic[] = missingRefs.map((id) => ({
      code: "convention-ref-unresolved",
      message: `Configured convention reference ${id} was not found in ${source.root}`,
    }));

    return envelope(
      missingRefs.length > 0 ? "failed" : "passed",
      started,
      {
        root,
        repositoryName: basename(root),
        sourceRoot: source.root,
        source: source.source,
        sourceRevision: revision(source.root),
        technologies,
        files: [...files.values()],
        conventionIds: selectedConventionIds,
        explicitRefs: resolvedRefs,
        localInstructions,
        precedence: ["repository-local", "technology", "general", "principle"],
      },
      diagnostics,
    );
  } catch (error) {
    return envelope("error", started, { root, files: [] }, [
      {
        code: "conventions-resolution-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

function envelope(
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "conventions",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}
