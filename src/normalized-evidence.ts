import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverComponents } from "./core.ts";
import { readJson } from "./shared.ts";
import { createPackageEvidence, type PackageEvidenceV1 } from "../site/evidence-model.js";

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
      return createPackageEvidence({
        collector: "filesystem",
        name: component.name,
        path: component.path,
        manifestPath: component.path === "." ? "package.json" : `${component.path}/package.json`,
        packageManager: manifest.packageManager,
        scripts: manifest.scripts,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        hasTsconfig: existsSync(join(directory, "tsconfig.json")),
        tsconfigPath: component.path === "." ? "tsconfig.json" : `${component.path}/tsconfig.json`,
        lockfiles: packageLockfiles.filter((name) => existsSync(join(directory, name))),
      });
    });
}
