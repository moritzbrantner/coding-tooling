import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { discoverComponents } from "./core.ts";
import { relativePosix, walkFiles } from "./shared.ts";
import { createPackageEvidence, type PackageEvidenceV1 } from "../site/evidence-model.js";
import {
  createProjectManifestEvidence,
  type ProjectManifestEvidenceV1,
} from "../site/project-evidence.js";
import {
  createProjectToolchainEvidence,
  projectToolchainPaths,
  type ProjectToolchainEvidenceV1,
} from "../site/project-toolchain.js";

type PackageManifest = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageLockfiles = ["bun.lock", "bun.lockb", "package-lock.json"] as const;

export function collectLocalPackageEvidence(root: string): PackageEvidenceV1[] {
  const components = new Map(
    discoverComponents(root)
      .filter((component) => component.kind === "package")
      .map((component) => [component.path, component]),
  );
  return (
    walkFiles(root, 4)
      .filter((path) => basename(path) === "package.json")
      .map((manifestPath) => {
        const directory = dirname(manifestPath);
        const path = relativePosix(root, directory);
        const component = components.get(path) ?? { path, name: basename(directory) };
        const content = readRegularText(manifestPath);
        let parsed: unknown;
        try {
          parsed = content === undefined ? undefined : JSON.parse(content);
        } catch {
          parsed = undefined;
        }
        const manifestComplete =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
        const manifest = manifestComplete ? (parsed as PackageManifest) : {};
        const nodeVersionPath = join(directory, ".node-version");
        return createPackageEvidence({
          collector: "filesystem",
          name: component.name,
          path: component.path,
          manifestPath: component.path === "." ? "package.json" : `${component.path}/package.json`,
          manifestComplete,
          packageManager: manifest.packageManager,
          nodeVersion: readRegularText(nodeVersionPath)?.trim(),
          nodeVersionPath:
            component.path === "." ? ".node-version" : `${component.path}/.node-version`,
          scripts: manifest.scripts,
          dependencies: manifest.dependencies,
          devDependencies: manifest.devDependencies,
          hasTsconfig: existsSync(join(directory, "tsconfig.json")),
          tsconfigPath:
            component.path === "." ? "tsconfig.json" : `${component.path}/tsconfig.json`,
          lockfiles: packageLockfiles.filter((name) => existsSync(join(directory, name))),
        });
      })
      // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh evidence array; the repository targets ES2022.
      .sort((left, right) => left.component.path.localeCompare(right.component.path))
  );
}

function readRegularText(path: string): string | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isFile()
      ? readFileSync(path, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}

export function collectLocalProjectManifestEvidence(root: string): ProjectManifestEvidenceV1[] {
  const files = walkFiles(root, 4);
  const relativeManifestPaths = files
    .filter(
      (file) =>
        basename(file) === "Cargo.toml" || file.endsWith(".sln") || file.endsWith(".csproj"),
    )
    .map((file) => relativePosix(root, file));

  return discoverComponents(root).flatMap((component) => {
    if (component.kind !== "rust" && component.kind !== "dotnet") return [];
    const kind = component.kind;
    const ownedPaths = relativeManifestPaths.filter((manifestPath) =>
      manifestBelongsToComponent(manifestPath, component.path, kind),
    );
    return [
      createProjectManifestEvidence({
        collector: "filesystem",
        name: component.name,
        path: component.path,
        kind,
        manifestPaths: ownedPaths,
        complete: ownedPaths.every((path) =>
          lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile(),
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

export function collectLocalProjectToolchainEvidence(root: string): ProjectToolchainEvidenceV1[] {
  return collectLocalProjectManifestEvidence(root).map(({ component }) => {
    const files: Record<string, string | null> = {};
    for (const path of projectToolchainPaths(component.path, component.kind)) {
      const absolutePath = join(root, path);
      try {
        const metadata = lstatSync(absolutePath, { throwIfNoEntry: false });
        if (!metadata) continue;
        files[path] = metadata.isFile() ? readFileSync(absolutePath, "utf8") : null;
      } catch {
        files[path] = null;
      }
    }
    return createProjectToolchainEvidence({ collector: "filesystem", ...component, files });
  });
}
