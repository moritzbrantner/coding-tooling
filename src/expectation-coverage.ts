import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverComponents } from "./core.ts";
import { productionSourceFiles } from "./expectation-gap-detectors.ts";
import type { DetectorContext } from "./expectation-package-context.ts";
import type { ExpectationDescriptor } from "./expectation-detector-types.ts";

export type DetectorCoverageStatus = "applied" | "not-applicable" | "unsupported" | "unavailable";

export type DetectorCoverage = {
  id: string;
  version: number;
  status: DetectorCoverageStatus;
  subjects: number;
};

export type FindingsCoverage = {
  schemaVersion: 1;
  technologies: string[];
  detectors: DetectorCoverage[];
  unsupportedTechnologies: string[];
};

type CoverageTarget = "repository-config" | "packages" | "typescript-source" | "production-source";

const coverageTargets: Record<string, CoverageTarget> = {
  "benchmark-evidence": "packages",
  "package-aggregate-check": "packages",
  "package-cli-wiring": "packages",
  "package-test-capability": "typescript-source",
  "required-capability-available": "repository-config",
  "source-debt-marker": "production-source",
  "source-unimplemented-stub": "production-source",
  "typescript-project-config": "typescript-source",
  "typescript-source-test": "typescript-source",
};

function detectorSubjects(root: string, context: DetectorContext, target: CoverageTarget): number {
  switch (target) {
    case "repository-config":
      return existsSync(join(root, ".coding-tooling.json")) ? 1 : 0;
    case "packages":
      return context.packages.length;
    case "typescript-source":
      return context.packages.reduce(
        (total, packageInfo) => total + packageInfo.sourceFiles.length,
        0,
      );
    case "production-source":
      return productionSourceFiles(root).length;
  }
}

function unsupportedTechnologies(root: string, context: DetectorContext): string[] {
  const components = discoverComponents(root);
  const typeScriptPackagePaths = new Set(
    context.packages
      .filter((packageInfo) => packageInfo.sourceFiles.length > 0)
      .map((packageInfo) => packageInfo.path),
  );
  const unsupported = new Set<string>();

  for (const component of components) {
    if (component.technologies.includes("rust")) unsupported.add("rust");
    if (component.technologies.includes("dotnet")) unsupported.add("dotnet");
    if (
      component.kind === "package" &&
      component.technologies.includes("javascript") &&
      !component.technologies.includes("typescript") &&
      !typeScriptPackagePaths.has(component.path)
    ) {
      unsupported.add("javascript");
    }
  }

  return [...unsupported].sort();
}

export function analyzeFindingsCoverage(
  root: string,
  context: DetectorContext,
  descriptors: readonly ExpectationDescriptor[],
): FindingsCoverage {
  const components = discoverComponents(root);
  const technologies = [
    ...new Set(components.flatMap((component) => component.technologies)),
  ].sort();
  const detectors = descriptors.map((descriptor) => {
    const target = coverageTargets[descriptor.id];
    if (!target) {
      return {
        id: descriptor.id,
        version: descriptor.version,
        status: "unavailable" as const,
        subjects: 0,
      };
    }
    const subjects = detectorSubjects(root, context, target);
    return {
      id: descriptor.id,
      version: descriptor.version,
      status: subjects > 0 ? ("applied" as const) : ("not-applicable" as const),
      subjects,
    };
  });

  return {
    schemaVersion: 1,
    technologies,
    detectors,
    unsupportedTechnologies: unsupportedTechnologies(root, context),
  };
}
