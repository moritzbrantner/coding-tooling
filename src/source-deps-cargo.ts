// Cargo manifest discovery and crate-graph verification for `source-deps` (#313).
//
// Cargo applies `[patch.<source>]` per dependency source. A consumer that depends on a declared
// source package through `git = "<url>"` must be patched under `[patch."<url>"]`; a crates-io
// patch is silently unused. This module finds how the consumer declares each package and, after
// activation, proves with `cargo metadata` that every generated patch is used.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { TOML } from "bun";

import { canonicalGitRepository } from "./shared.ts";

type RecordValue = Record<string, unknown>;

export type CargoDependencyDeclarations = {
  /** Consumer manifests that were read, absolute paths. */
  manifests: string[];
  /** Git URL spellings by package name, exactly as the consumer writes them. */
  git: Map<string, Set<string>>;
  /** Packages the consumer declares from the default (crates-io) registry. */
  registry: Set<string>;
};

const dependencyTables = [
  "dependencies",
  "dev-dependencies",
  "dev_dependencies",
  "build-dependencies",
  "build_dependencies",
];

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(path: string): RecordValue {
  const parsed: unknown = TOML.parse(readFileSync(path, "utf8"));
  if (!record(parsed)) throw new Error(`Invalid Cargo manifest: ${path}`);
  return parsed;
}

function globSegment(segment: string): RegExp {
  let pattern = "";
  for (const character of segment) {
    if (character === "*") pattern += "[^/\\\\]*";
    else if (character === "?") pattern += "[^/\\\\]";
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Expands a Cargo workspace member pattern (`*`, `?` and `**` segments) below `base`. */
function expandMemberPattern(base: string, pattern: string): string[] {
  let current = [base];
  for (const segment of pattern.split(/[/\\]+/).filter(Boolean)) {
    const next: string[] = [];
    for (const directory of current) {
      if (segment === "**") {
        const stack = [directory];
        while (stack.length) {
          const candidate = stack.pop() as string;
          next.push(candidate);
          for (const child of directories(candidate))
            if (child !== "target" && child !== ".git") stack.push(join(candidate, child));
        }
      } else if (/[*?]/.test(segment)) {
        const matcher = globSegment(segment);
        for (const child of directories(directory))
          if (matcher.test(child)) next.push(join(directory, child));
      } else {
        next.push(join(directory, segment));
      }
    }
    current = next;
  }
  return current;
}

function comparablePath(path: string): string {
  let value = resolve(path);
  try {
    value = realpathSync.native(value);
  } catch {
    // Keep the resolved path when it does not exist.
  }
  value = normalize(value);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function workspaceManifests(root: string): string[] {
  const rootManifest = join(root, "Cargo.toml");
  if (!existsSync(rootManifest)) return [];
  const manifests = new Map<string, string>([[comparablePath(rootManifest), rootManifest]]);
  const workspace = parseManifest(rootManifest).workspace;
  if (!record(workspace)) return [rootManifest];
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const excluded = new Set(
    strings(workspace.exclude).flatMap((pattern) =>
      expandMemberPattern(root, pattern).map(comparablePath),
    ),
  );
  for (const pattern of strings(workspace.members)) {
    for (const member of expandMemberPattern(root, pattern)) {
      const manifest = join(member, "Cargo.toml");
      if (excluded.has(comparablePath(member)) || !existsSync(manifest)) continue;
      manifests.set(comparablePath(manifest), manifest);
    }
  }
  return [...manifests.values()];
}

function collectTable(table: unknown, declarations: CargoDependencyDeclarations): void {
  if (!record(table)) return;
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === "string") {
      declarations.registry.add(key);
      continue;
    }
    if (!record(value) || value.workspace === true) continue;
    const name = typeof value.package === "string" ? value.package : key;
    if (typeof value.git === "string") {
      const spellings = declarations.git.get(name) ?? new Set<string>();
      spellings.add(value.git);
      declarations.git.set(name, spellings);
    } else if (value.path === undefined && value.registry === undefined) {
      declarations.registry.add(name);
    }
  }
}

/**
 * Reads the consumer's root `Cargo.toml` and its workspace members and records how each
 * dependency is declared: `[workspace.dependencies]`, `[dependencies]`, `[dev-dependencies]`,
 * `[build-dependencies]` and their `[target.<cfg>.*]` variants, honouring `package = ...` renames.
 */
export function cargoDependencyDeclarations(root: string): CargoDependencyDeclarations {
  const declarations: CargoDependencyDeclarations = {
    manifests: workspaceManifests(root),
    git: new Map(),
    registry: new Set(),
  };
  for (const manifest of declarations.manifests) {
    const data = parseManifest(manifest);
    if (record(data.workspace)) collectTable(data.workspace.dependencies, declarations);
    for (const table of dependencyTables) collectTable(data[table], declarations);
    if (record(data.target)) {
      for (const target of Object.values(data.target)) {
        if (!record(target)) continue;
        for (const table of dependencyTables) collectTable(target[table], declarations);
      }
    }
  }
  return declarations;
}

/** The consumer's spellings of `git` for `name`, matched canonically, sorted. */
export function consumerGitSources(
  declarations: CargoDependencyDeclarations,
  name: string,
  git: string,
): string[] {
  const wanted = canonicalGitRepository(git);
  return [...(declarations.git.get(name) ?? [])]
    .filter((spelling) => canonicalGitRepository(spelling) === wanted)
    .sort();
}

export type RenderedCargoPatch = {
  package: string;
  git: string;
  /** Absolute local checkout path when the patch resolves to a sibling checkout. */
  localPath?: string;
  /** Patch section keys: `crates-io` or the consumer's git URL spelling. */
  sources: string[];
};

type MetadataPackage = { name: string; source: string | null; manifest_path: string };

function gitSourceUrl(source: string): string | undefined {
  if (!source.startsWith("git+")) return undefined;
  return source.slice(4).replace(/[?#].*$/, "");
}

function snapshot(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

function restore(path: string, before: Buffer | undefined): void {
  if (before === undefined) {
    rmSync(path, { force: true });
    return;
  }
  const after = snapshot(path);
  if (!after || !after.equals(before)) writeFileSync(path, before);
}

function cargoMetadata(root: string): { stdout: string; stderr: string } {
  // `cargo metadata` may write Cargo.lock; activation must not change the consumer's lockfile.
  const lockfile = join(root, "Cargo.lock");
  const before = snapshot(lockfile);
  try {
    const run = (offline: boolean) =>
      spawnSync("cargo", ["metadata", "--format-version", "1", ...(offline ? ["--offline"] : [])], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
      });
    // Offline first: local sources and an already-populated Cargo cache need no network.
    let result = run(true);
    if (result.error) {
      throw new Error(`cargo is required to verify Cargo source patches: ${result.error.message}`);
    }
    if (result.status !== 0) result = run(false);
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim().split("\n").slice(-20).join("\n");
      throw new Error(`cargo metadata failed while verifying Cargo source patches:\n${detail}`);
    }
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  } finally {
    restore(lockfile, before);
  }
}

/**
 * Runs `cargo metadata` in the consumer and returns one message per generated patch that the
 * crate graph does not use. Returns `undefined` when the consumer root has no Cargo manifest.
 */
export function unusedCargoPatches(
  root: string,
  patches: RenderedCargoPatch[],
): string[] | undefined {
  if (!patches.length || !existsSync(join(root, "Cargo.toml"))) return undefined;
  const { stdout, stderr } = cargoMetadata(root);
  const metadata = JSON.parse(stdout) as { packages?: MetadataPackage[] };
  const packages = metadata.packages ?? [];
  const warned = new Set(
    [...stderr.matchAll(/Patch `([^`\s]+)[^`]*` was not used in the crate graph/gi)].map(
      (match) => match[1],
    ),
  );
  const failures: string[] = [];
  for (const patch of patches) {
    const entries = packages.filter((entry) => entry.name === patch.package);
    const sections = patch.sources.join(", ");
    if (patch.localPath) {
      const expected = comparablePath(patch.localPath);
      const local = entries.some(
        (entry) =>
          entry.source === null && comparablePath(dirname(entry.manifest_path)) === expected,
      );
      const remote = entries.filter((entry) => {
        const url = entry.source ? gitSourceUrl(entry.source) : undefined;
        return (
          url !== undefined && canonicalGitRepository(url) === canonicalGitRepository(patch.git)
        );
      });
      if (!local || warned.has(patch.package)) {
        failures.push(
          `Cargo source patch ${patch.package} (${sections}) was not used in the crate graph: no package resolves from ${patch.localPath}`,
        );
      } else if (remote.length) {
        failures.push(
          `Cargo source patch ${patch.package} (${sections}) left ${remote.map((entry) => entry.source).join(", ")} in the crate graph`,
        );
      }
    } else if (!entries.length || warned.has(patch.package)) {
      failures.push(
        `Cargo source patch ${patch.package} (${sections}) was not used in the crate graph`,
      );
    }
  }
  return failures;
}
