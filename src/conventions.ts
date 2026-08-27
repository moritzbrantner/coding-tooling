import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  compact?: boolean;
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

type ConventionCatalog = {
  schemaVersion: 1;
  principles: string[];
  general: string[];
  scopes: Record<string, { path: string; parents?: string[] }>;
  profiles: Record<string, { scopes: string[]; refs?: string[]; extends?: string[] }>;
  conventionIds: Record<string, string>;
};

type ResolvedProfile = { scopes: string[]; refs: string[] };

type ConventionCatalogSource = Pick<ConventionCatalog, "schemaVersion" | "scopes" | "profiles">;

type ConventionCatalogOptions = {
  root?: string;
  conventionsRoot?: string;
  write?: boolean;
  check?: boolean;
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
  const paths = [
    ...markdownFiles(root, "principles"),
    ...markdownFiles(root, "conventions"),
    ...markdownFiles(root, "technologies"),
  ];
  for (const path of paths) {
    const source = readFileSync(join(root, path), "utf8");
    for (const match of source.matchAll(/^##\s+([A-Z][A-Z0-9-]*-\d+)\b/gm)) {
      const id = match[1];
      const previous = index.get(id);
      if (previous && previous !== path) {
        throw new Error(`Convention ID ${id} is defined in both ${previous} and ${path}`);
      }
      index.set(id, path);
    }
  }
  return index;
}

function conventionCatalog(root: string): ConventionCatalog | undefined {
  const catalog = readJson<ConventionCatalog>(join(root, "catalog.json"));
  if (!catalog) return undefined;
  if (catalog.schemaVersion !== 1) throw new Error("catalog.json must use schemaVersion 1");
  return catalog;
}

export function buildConventionCatalog(root: string): ConventionCatalog {
  const source = readJson<ConventionCatalogSource>(join(root, "catalog.source.json"));
  if (!source || source.schemaVersion !== 1)
    throw new Error("catalog.source.json must use schemaVersion 1");
  for (const [scope, entry] of Object.entries(source.scopes)) {
    if (!existsSync(join(root, entry.path)))
      throw new Error(`Convention scope ${scope} references missing file ${entry.path}`);
  }
  for (const profile of Object.keys(source.profiles)) {
    try {
      const catalog = { ...source, principles: [], general: [], conventionIds: {} };
      const resolved = resolveProfile(catalog, profile);
      expandScopes(catalog, resolved.scopes);
    } catch (error) {
      throw new Error(
        `Convention profile ${profile} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    schemaVersion: 1,
    principles: markdownFiles(root, "principles"),
    general: markdownFiles(root, "conventions"),
    scopes: Object.fromEntries(
      Object.entries(source.scopes).sort(([left], [right]) => left.localeCompare(right)),
    ),
    profiles: Object.fromEntries(
      Object.entries(source.profiles).sort(([left], [right]) => left.localeCompare(right)),
    ),
    conventionIds: Object.fromEntries(
      [...conventionIds(root)].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function resolveProfile(catalog: ConventionCatalog, profile: string): ResolvedProfile {
  const scopes = new Set<string>();
  const refs = new Set<string>();
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    if (active.has(name)) throw new Error(`Convention profile inheritance cycle at ${name}`);
    const entry = catalog.profiles[name];
    if (!entry) throw new Error(`Convention profile ${name} was not found in catalog.json`);
    active.add(name);
    for (const parent of entry.extends ?? []) visit(parent);
    active.delete(name);
    for (const scope of entry.scopes) scopes.add(scope);
    for (const ref of entry.refs ?? []) refs.add(ref);
    seen.add(name);
  };
  visit(profile);
  return { scopes: [...scopes], refs: [...refs] };
}

export function catalogConventions(
  options: ConventionCatalogOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.conventionsRoot ?? options.root ?? repositoryRoot());
  try {
    if (!validConventionsRoot(root))
      return envelope("unavailable", started, { root }, [
        {
          code: "conventions-source-unavailable",
          message: `${root} is not a coding-agent-conventions checkout`,
        },
      ]);
    if (options.write && options.check)
      throw new Error("Use only one of --write or --check for conventions catalog");
    const catalog = buildConventionCatalog(root);
    const content = `${JSON.stringify(catalog)}\n`;
    const path = join(root, "catalog.json");
    if (options.write) writeFileSync(path, content);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const matches = current === content;
    const diagnostics: Diagnostic[] = [];
    if (options.check && !matches)
      diagnostics.push({
        code: "conventions-catalog-stale",
        message: "catalog.json does not match catalog.source.json and current convention files",
        path,
      });
    return envelope(
      diagnostics.length > 0 ? "failed" : "passed",
      started,
      {
        root,
        path,
        matches,
        wrote: Boolean(options.write),
        catalog,
      },
      diagnostics,
    );
  } catch (error) {
    return envelope("error", started, { root }, [
      {
        code: "conventions-catalog-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

function expandScopes(catalog: ConventionCatalog, scopes: string[]): string[] {
  const resolved: string[] = [];
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = (scope: string): void => {
    if (seen.has(scope)) return;
    if (active.has(scope)) throw new Error(`Convention scope inheritance cycle at ${scope}`);
    const entry = catalog.scopes[scope];
    if (!entry) throw new Error(`Convention scope ${scope} was not found in catalog.json`);
    active.add(scope);
    for (const parent of entry.parents ?? []) visit(parent);
    active.delete(scope);
    seen.add(scope);
    resolved.push(scope);
  };
  for (const scope of scopes) visit(scope);
  return resolved;
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
    .filter((path) => basename(path) === "AGENTS.md")
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
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
    const inferredTechnologies = repositoryTechnologies(root);
    const catalog = conventionCatalog(source.root);
    const profile = config.conventionProfile;
    const resolvedProfile =
      profile && catalog?.profiles[profile] ? resolveProfile(catalog, profile) : undefined;
    const declaredScopes = [...(resolvedProfile?.scopes ?? []), ...(config.conventionScopes ?? [])];
    const resolvedScopes =
      catalog && declaredScopes.length > 0
        ? expandScopes(catalog, declaredScopes)
        : inferredTechnologies;
    const files = new Map<string, ConventionFile>();

    for (const path of catalog?.principles ?? markdownFiles(source.root, "principles")) {
      addFile(files, source.root, path, "principle");
    }
    for (const path of catalog?.general ?? markdownFiles(source.root, "conventions")) {
      addFile(files, source.root, path, "general");
    }

    for (const technology of resolvedScopes) {
      const path = catalog?.scopes[technology]?.path ?? technologyConventionPaths[technology];
      if (path) addFile(files, source.root, path, "technology");
    }

    const ids = catalog
      ? new Map(Object.entries(catalog.conventionIds))
      : conventionIds(source.root);
    const resolvedRefs: Record<string, string> = {};
    const missingRefs: string[] = [];
    for (const id of [...(resolvedProfile?.refs ?? []), ...(config.conventionRefs ?? [])]) {
      const path = ids.get(id);
      if (!path) {
        missingRefs.push(id);
        continue;
      }
      resolvedRefs[id] = path;
      addFile(files, source.root, path, "explicit-ref");
    }

    const exceptions = config.conventionExceptions ?? [];
    const missingExceptions = exceptions.filter(({ id }) => !ids.has(id));

    const selectedPaths = new Set(files.keys());
    const selectedConventionIds = [...ids.entries()]
      .filter(([, path]) => selectedPaths.has(path))
      .map(([id]) => id)
      .sort();
    const exceptedIds = new Set(exceptions.map(({ id }) => id));
    const effectiveConventionIds = selectedConventionIds.filter((id) => !exceptedIds.has(id));
    const localInstructions = localInstructionFiles(root);
    const catalogScopes = new Set(Object.keys(catalog?.scopes ?? technologyConventionPaths));
    const undeclaredTechnologies =
      declaredScopes.length > 0
        ? inferredTechnologies.filter(
            (technology) => catalogScopes.has(technology) && !resolvedScopes.includes(technology),
          )
        : [];
    const diagnostics: Diagnostic[] = missingRefs.map((id) => ({
      code: "convention-ref-unresolved",
      message: `Configured convention reference ${id} was not found in ${source.root}`,
    }));
    if (profile && !resolvedProfile) {
      diagnostics.push({
        code: "convention-profile-unresolved",
        message: `Configured convention profile ${profile} was not found in catalog.json`,
      });
    }
    diagnostics.push(
      ...missingExceptions.map(({ id }) => ({
        code: "convention-exception-unresolved",
        message: `Configured convention exception ${id} was not found in ${source.root}`,
      })),
      ...undeclaredTechnologies.map((technology) => ({
        code: "convention-scope-undeclared",
        message: `Inferred convention scope ${technology} is not covered by the declared profile or scopes`,
      })),
    );

    const resolvedFiles = [...files.values()];
    const data = {
      ...(options.compact ? {} : { root, sourceRoot: source.root, inferredTechnologies }),
      repositoryName: basename(root),
      source: source.source,
      sourceRevision: revision(source.root),
      profile,
      declaredScopes,
      resolvedScopes,
      technologies: resolvedScopes,
      undeclaredTechnologies,
      files: options.compact
        ? resolvedFiles.map(({ path, reason }) => ({ path, reason }))
        : resolvedFiles,
      ...(options.compact
        ? {
            conventionIdCount: selectedConventionIds.length,
            effectiveConventionIdCount: effectiveConventionIds.length,
          }
        : {
            conventionIds: selectedConventionIds,
            effectiveConventionIds,
          }),
      explicitRefs: resolvedRefs,
      exceptions,
      localInstructions: options.compact
        ? localInstructions.map((path) => relative(root, path).replaceAll("\\", "/"))
        : localInstructions,
      precedence: ["repository-local", "technology", "general", "principle"],
    };

    return envelope(diagnostics.length > 0 ? "failed" : "passed", started, data, diagnostics);
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
