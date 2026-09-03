import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverComponents } from "./core.ts";
import { productionSourceFiles } from "./expectation-gap-detectors.ts";
import type { DetectorContext } from "./expectation-package-context.ts";
import type { ExpectationDescriptor } from "./expectation-detector-types.ts";
import { explicitCargoTargets } from "./expectation-rust-detector.ts";
import { rustTestSurfaces } from "./expectation-rust-test-detector.ts";

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

type CoverageTarget =
  | "repository-config"
  | "packages"
  | "typescript-source"
  | "typescript-analysis-projects"
  | "javascript-source"
  | "script-source"
  | "rust-explicit-targets"
  | "rust-source-surface"
  | "production-source";

const coverageTargets: Record<string, CoverageTarget> = {
  "benchmark-evidence": "packages",
  "javascript-source-test": "javascript-source",
  "package-aggregate-check": "packages",
  "package-cli-wiring": "packages",
  "package-test-capability": "script-source",
  "required-capability-available": "repository-config",
  "rust-cargo-target-path": "rust-explicit-targets",
  "rust-source-test": "rust-source-surface",
  "source-debt-marker": "production-source",
  "source-unimplemented-stub": "production-source",
  "typescript-project-config": "typescript-source",
  "typescript-source-test": "typescript-source",
  "typescript-type-assignability": "typescript-analysis-projects",
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
    case "typescript-analysis-projects":
      return context.analysisProvider("typescript-compiler")?.projects.length ?? 0;
    case "javascript-source":
      return context.packages.reduce(
        (total, packageInfo) => total + packageInfo.javaScriptSourceFiles.length,
        0,
      );
    case "script-source":
      return context.packages.reduce(
        (total, packageInfo) =>
          total + packageInfo.sourceFiles.length + packageInfo.javaScriptSourceFiles.length,
        0,
      );
    case "rust-explicit-targets":
      return explicitCargoTargets(root).length;
    case "rust-source-surface":
      return rustTestSurfaces(root).length;
    case "production-source":
      return productionSourceFiles(root).length;
  }
}

function semanticTypeScriptCoverage(context: DetectorContext): {
  status: DetectorCoverageStatus;
  subjects: number;
} {
  const provider = context.analysisProvider("typescript-compiler");
  if (!provider) return { status: "unavailable", subjects: 0 };
  const subjects = provider.projects.length;
  if (provider.status === "applied") return { status: "applied", subjects };
  if (provider.status === "not-applicable") return { status: "not-applicable", subjects: 0 };
  return { status: "unavailable", subjects };
}

function unsupportedTechnologies(root: string): string[] {
  const components = discoverComponents(root);
  const unsupported = new Set<string>();

  for (const component of components) {
    if (component.technologies.includes("rust")) unsupported.add("rust");
    if (component.technologies.includes("dotnet")) unsupported.add("dotnet");
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
    if (target === "typescript-analysis-projects") {
      return {
        id: descriptor.id,
        version: descriptor.version,
        ...semanticTypeScriptCoverage(context),
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
    unsupportedTechnologies: unsupportedTechnologies(root),
  };
}
