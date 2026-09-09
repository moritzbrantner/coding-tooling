import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { discoverComponents } from "./core.ts";
import { readJson, relativePosix, walkFiles } from "./shared.ts";
import { createPackageEvidence, type PackageEvidenceV1 } from "../site/evidence-model.js";
import {
  createProjectManifestEvidence,
  type ProjectManifestEvidenceV1,
} from "../site/project-evidence.js";

type PackageManifest = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageLockfiles = ["bun.lock", "bun.lockb", "package-lock.json"] as const;

export function collectLocalPackageEvidence(root: string): PackageEvidenceV1[] {
  return discoverComponents(root)
    .filter((component) => component.kind === "package")
    .map((component) => {
      const directory = component.path === "." ? root : join(root, component.path);
      const manifestPath = join(directory, "package.json");
      const manifest = readJson<PackageManifest>(manifestPath) ?? {};
      const nodeVersionPath = join(directory, ".node-version");
      return createPackageEvidence({
        collector: "filesystem",
        name: component.name,
        path: component.path,
        manifestPath: component.path === "." ? "package.json" : `${component.path}/package.json`,
        packageManager: manifest.packageManager,
        nodeVersion: existsSync(nodeVersionPath)
          ? readFileSync(nodeVersionPath, "utf8").trim()
          : undefined,
        nodeVersionPath:
          component.path === "." ? ".node-version" : `${component.path}/.node-version`,
        scripts: manifest.scripts,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        hasTsconfig: existsSync(join(directory, "tsconfig.json")),
        tsconfigPath: component.path === "." ? "tsconfig.json" : `${component.path}/tsconfig.json`,
        lockfiles: packageLockfiles.filter((name) => existsSync(join(directory, name))),
      });
    });
}

export function collectLocalProjectManifestEvidence(root: string): ProjectManifestEvidenceV1[] {
  const files = walkFiles(root, 4);
  const relativeManifestPaths = files
    .filter(
      (file) => basename(file) === "Cargo.toml" || file.endsWith(".sln") || file.endsWith(".csproj"),
    )
    .map((file) => relativePosix(root, file));

  return discoverComponents(root).flatMap((component) => {
    if (component.kind !== "rust" && component.kind !== "dotnet") return [];
    const kind = component.kind;
    return [
      createProjectManifestEvidence({
        collector: "filesystem",
        name: component.name,
        path: component.path,
        kind,
        manifestPaths: relativeManifestPaths.filter((manifestPath) =>
          manifestBelongsToComponent(manifestPath, component.path, kind),
        ),
      }),
    ];
  });
}

function manifestBelongsToComponent(
  manifestPath: string,
  componentPath: string,
  kind: "rust" | "dotnet",
): boolean {
  const manifestDirectory = dirname(manifestPath).replaceAll("\\", "/") || ".";
  if (manifestDirectory !== componentPath) return false;
  if (kind === "rust") return basename(manifestPath) === "Cargo.toml";
  return manifestPath.endsWith(".sln") || manifestPath.endsWith(".csproj");
}
