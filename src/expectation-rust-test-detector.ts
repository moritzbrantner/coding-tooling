import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { discoverComponents } from "./core.ts";
import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { cargoPackageName, explicitCargoTargets } from "./expectation-rust-detector.ts";
import { relativePosix, walkFiles } from "./shared.ts";

type RustComponentTestContext = {
  directory: string;
  path: string;
  manifestPath: string;
  manifestRelative: string;
  crateName?: string;
  rustFiles: string[];
  sourceFiles: string[];
  sourceRoots: string[];
  libRoot?: string;
  binaryRoots: Map<string, string>;
  integrationRoots: string[];
};

type ModuleDeclaration = {
  name: string;
  pathOverride?: string;
};

const inlineTestModulePattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/m;
const moduleDeclarationPattern = /((?:\s*#\s*\[[^\]]+\]\s*)*)\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
const cfgAttributePattern = /#\s*\[\s*cfg\s*\(/;
const pathAttributePattern = /#\s*\[\s*path\s*=\s*"([^"\r\n]+)"\s*\]/;
const excludedSourcePathPattern = /^src\/(?:test|tests|__tests__|generated|gen)\//;

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isWithin(directory: string, path: string): boolean {
  const local = relative(directory, path);
  return local === "" || (!local.startsWith("..") && !isAbsolute(local));
}

function rustComponentContexts(root: string): RustComponentTestContext[] {
  const components = discoverComponents(root)
    .filter((component) => component.kind === "rust")
    .map((component) => ({
      path: component.path,
      directory: resolve(root, component.path),
    }));
  const directories = components
    .map((component) => component.directory)
    .sort((left, right) => right.length - left.length);
  const rustFiles = walkFiles(root, 10)
    .filter((path) => extname(path) === ".rs")
    .sort();
  const targets = explicitCargoTargets(root);

  return components
    .map((component) => {
      const manifestPath = join(component.directory, "Cargo.toml");
      const manifestRelative = relativePosix(root, manifestPath);
      const ownedFiles = rustFiles.filter((path) => {
        const owner = directories.find((directory) => isWithin(directory, path));
        return owner === component.directory;
      });
      const sourceFiles = ownedFiles.filter((path) => {
        const local = relativePosix(component.directory, path);
        return local.startsWith("src/") && !excludedSourcePathPattern.test(local);
      });
      const componentTargets = targets.filter((target) => target.manifestPath === manifestRelative);
      const explicitLib = componentTargets.find((target) => target.kind === "lib");
      const defaultLib = join(component.directory, "src", "lib.rs");
      const libRoot = explicitLib
        ? join(root, explicitLib.resolvedPath)
        : existsSync(defaultLib)
          ? defaultLib
          : undefined;
      const crateName = cargoPackageName(manifestPath);
      const binaryRoots = new Map<string, string>();
      for (const target of componentTargets.filter((target) => target.kind === "bin")) {
        if (target.name) binaryRoots.set(target.name, join(root, target.resolvedPath));
      }
      const defaultMain = join(component.directory, "src", "main.rs");
      if (crateName && existsSync(defaultMain) && ![...binaryRoots.values()].includes(defaultMain)) {
        binaryRoots.set(crateName, defaultMain);
      }
      for (const source of sourceFiles) {
        const local = relativePosix(component.directory, source);
        const match = /^src\/bin\/([^/]+)\.rs$/.exec(local);
        if (match?.[1] && ![...binaryRoots.values()].includes(source)) {
          binaryRoots.set(match[1], source);
        }
      }
      const directIntegrationRoots = ownedFiles.filter((path) =>
        /^tests\/[^/]+\.rs$/.test(relativePosix(component.directory, path)),
      );
      const explicitIntegrationRoots = componentTargets
        .filter((target) => target.kind === "test")
        .map((target) => join(root, target.resolvedPath));
      const integrationRoots = [...new Set([...directIntegrationRoots, ...explicitIntegrationRoots])]
        .filter((path) => existsSync(path))
        .sort();
      const sourceRoots = [libRoot, ...binaryRoots.values()]
        .filter((path): path is string => path !== undefined && existsSync(path))
        .sort();

      return {
        directory: component.directory,
        path: component.path,
        manifestPath,
        manifestRelative,
        crateName,
        rustFiles: ownedFiles,
        sourceFiles,
        sourceRoots,
        libRoot,
        binaryRoots,
        integrationRoots,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function moduleDeclarations(content: string): ModuleDeclaration[] {
  const declarations: ModuleDeclaration[] = [];
  for (const match of content.matchAll(moduleDeclarationPattern)) {
    const attributes = match[1] ?? "";
    const name = match[2];
    if (!name || cfgAttributePattern.test(attributes)) continue;
    declarations.push({
      name,
      pathOverride: pathAttributePattern.exec(attributes)?.[1],
    });
  }
  return declarations;
}

function moduleBase(parent: string, crateRoot: boolean): string {
  if (crateRoot || basename(parent) === "mod.rs") return dirname(parent);
  return join(dirname(parent), basename(parent, ".rs"));
}

function resolveModule(
  parent: string,
  declaration: ModuleDeclaration,
  knownFiles: ReadonlySet<string>,
  crateRoot: boolean,
): string | undefined {
  if (declaration.pathOverride) {
    const candidate = resolve(dirname(parent), declaration.pathOverride);
    return knownFiles.has(candidate) ? candidate : undefined;
  }
  const base = moduleBase(parent, crateRoot);
  return [join(base, `${declaration.name}.rs`), join(base, declaration.name, "mod.rs")].find(
    (candidate) => knownFiles.has(candidate),
  );
}

function graphReachability(
  seeds: readonly string[],
  knownFiles: ReadonlySet<string>,
  crateRoots: ReadonlySet<string>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = seeds.filter((seed) => knownFiles.has(seed));
  while (queue.length > 0) {
    const source = queue.shift()!;
    if (reachable.has(source)) continue;
    reachable.add(source);
    const content = readSource(source);
    if (content === undefined) continue;
    for (const declaration of moduleDeclarations(content)) {
      const child = resolveModule(source, declaration, knownFiles, crateRoots.has(source));
      if (child && !reachable.has(child)) queue.push(child);
    }
  }
  return reachable;
}

function rustCrateIdentifier(name: string): string {
  return name.replace(/-/g, "_");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function integrationTestSources(component: RustComponentTestContext): Set<string> {
  const known = new Set(component.rustFiles.map((path) => resolve(path)));
  const roots = new Set(component.integrationRoots.map((path) => resolve(path)));
  return graphReachability([...roots], known, roots);
}

function externalSeeds(component: RustComponentTestContext): string[] {
  const tests = integrationTestSources(component);
  const seeds = new Set<string>();
  const crateIdentifier = component.crateName ? rustCrateIdentifier(component.crateName) : undefined;
  const cratePattern = crateIdentifier
    ? new RegExp(`\\b(?:extern\\s+crate\\s+${escapeRegex(crateIdentifier)}\\b|${escapeRegex(crateIdentifier)}\\s*::)`)
    : undefined;
  let referencesLibrary = false;

  for (const testFile of tests) {
    const content = readSource(testFile);
    if (content === undefined) continue;
    if (cratePattern?.test(content)) referencesLibrary = true;
    for (const [name, source] of component.binaryRoots) {
      if (content.includes(`CARGO_BIN_EXE_${name}`)) seeds.add(resolve(source));
    }
  }
  if (referencesLibrary && component.libRoot) seeds.add(resolve(component.libRoot));
  return [...seeds].sort();
}

function inlineTestSeeds(component: RustComponentTestContext): string[] {
  return component.sourceFiles
    .filter((source) => inlineTestModulePattern.test(readSource(source) ?? ""))
    .map((source) => resolve(source))
    .sort();
}

export function rustTestSurfaces(root: string): string[] {
  return rustComponentContexts(root)
    .flatMap((component) => {
      const known = new Set(component.sourceFiles.map((path) => resolve(path)));
      const roots = new Set(component.sourceRoots.map((path) => resolve(path)));
      return [...graphReachability([...roots], known, roots)];
    })
    .map((path) => relativePosix(root, path))
    .sort();
}

function verification(component: RustComponentTestContext): string[][] {
  return component.manifestRelative === "Cargo.toml"
    ? [["cargo", "test"]]
    : [["cargo", "test", "--manifest-path", component.manifestRelative]];
}

export function missingRustTestFindings({ root }: DetectorContext): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const component of rustComponentContexts(root)) {
    const known = new Set(component.sourceFiles.map((path) => resolve(path)));
    const roots = new Set(component.sourceRoots.map((path) => resolve(path)));
    const surfaces = graphReachability([...roots], known, roots);
    const seeds = [...inlineTestSeeds(component), ...externalSeeds(component)];
    const tested = graphReachability(seeds, known, roots);

    for (const source of [...surfaces].sort()) {
      if (tested.has(source)) continue;
      const sourcePath = relativePosix(root, source);
      findings.push({
        subject: {
          kind: "file",
          key: sourcePath,
          path: sourcePath,
          description: `Rust source ${sourcePath}`,
        },
        requirement: {
          kind: "test",
          key: "rust-structural-test-reachability",
          description: "mechanically provable Rust structural test reachability",
        },
        message: `${sourcePath} is not deterministically reachable from recognized Rust test evidence`,
        evidence: [
          { kind: "file", path: sourcePath, detail: "reachable Rust production source exists" },
          {
            kind: "manifest",
            path: component.manifestRelative,
            detail: "Rust test verification resolves through cargo test",
          },
        ],
        relatedFiles: [sourcePath, component.manifestRelative],
        verification: verification(component),
      });
    }
  }
  return findings;
}
