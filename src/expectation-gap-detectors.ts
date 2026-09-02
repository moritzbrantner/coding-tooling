import { readFileSync } from "node:fs";
import { extname } from "node:path";

import type { DetectorContext, PackageInfo } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix, walkFiles } from "./shared.ts";

const sourceExtensions = new Set([
  ".cjs",
  ".cs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
]);

const testPathPattern = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/;
const testFilePattern = /\.(?:test|spec)\.[^.]+$/;
const storyFilePattern = /\.(?:stories|story)\.[^.]+$/;
const generatedPathPattern = /(?:^|\/)(?:generated|gen)(?:\/|$)/;
const debtMarkerPattern = /(?:\/\/|#|\/\*|\*)\s*(?:TODO|FIXME)\b/i;
const unimplementedPatterns = [
  /\b(?:todo|unimplemented)!\s*\(/,
  /\bthrow\s+new\s+NotImplementedException\s*\(/,
  /\bthrow\s+new\s+Error\s*\(\s*["'`]Not implemented\b/i,
];

function productionSourceFiles(root: string): string[] {
  return walkFiles(root, 8)
    .filter((path) => {
      const local = relativePosix(root, path);
      if (!sourceExtensions.has(extname(local))) return false;
      if (local.endsWith(".d.ts")) return false;
      if (testPathPattern.test(local) || testFilePattern.test(local)) return false;
      if (storyFilePattern.test(local) || generatedPathPattern.test(local)) return false;
      return true;
    })
    .sort();
}

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function markerEvidence(
  content: string,
  pattern: RegExp,
): { line: number; count: number } | undefined {
  let firstLine: number | undefined;
  let count = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!pattern.test(line)) continue;
    firstLine ??= index + 1;
    count += 1;
  }
  return firstLine === undefined ? undefined : { line: firstLine, count };
}

function unimplementedEvidence(content: string): { line: number; count: number } | undefined {
  let firstLine: number | undefined;
  let count = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!unimplementedPatterns.some((pattern) => pattern.test(line))) continue;
    firstLine ??= index + 1;
    count += 1;
  }
  return firstLine === undefined ? undefined : { line: firstLine, count };
}

export function sourceDebtMarkerFindings({ root }: DetectorContext): RawFinding[] {
  return productionSourceFiles(root).flatMap((path) => {
    const content = readSource(path);
    if (content === undefined) return [];
    const marker = markerEvidence(content, debtMarkerPattern);
    if (!marker) return [];
    const sourcePath = relativePosix(root, path);
    return [
      {
        subject: {
          kind: "file" as const,
          key: sourcePath,
          path: sourcePath,
          description: `Source file ${sourcePath}`,
        },
        requirement: {
          kind: "signal" as const,
          key: "resolve-debt-marker",
          description: "resolve or explicitly suppress TODO/FIXME production debt",
        },
        message: `${sourcePath} contains ${marker.count} TODO/FIXME debt marker${marker.count === 1 ? "" : "s"}`,
        evidence: [
          {
            kind: "file" as const,
            path: sourcePath,
            detail: `first debt marker is on line ${marker.line}`,
          },
        ],
        relatedFiles: [sourcePath],
        verification: [],
      },
    ];
  });
}

export function sourceUnimplementedStubFindings({ root }: DetectorContext): RawFinding[] {
  return productionSourceFiles(root).flatMap((path) => {
    const content = readSource(path);
    if (content === undefined) return [];
    const marker = unimplementedEvidence(content);
    if (!marker) return [];
    const sourcePath = relativePosix(root, path);
    return [
      {
        subject: {
          kind: "file" as const,
          key: sourcePath,
          path: sourcePath,
          description: `Source file ${sourcePath}`,
        },
        requirement: {
          kind: "signal" as const,
          key: "replace-unimplemented-stub",
          description: "replace production unimplemented stubs with implemented behavior",
        },
        message: `${sourcePath} contains ${marker.count} explicit unimplemented stub${marker.count === 1 ? "" : "s"}`,
        evidence: [
          {
            kind: "file" as const,
            path: sourcePath,
            detail: `first explicit stub is on line ${marker.line}`,
          },
        ],
        relatedFiles: [sourcePath],
        verification: [],
      },
    ];
  });
}

function selectedTestScript(packageInfo: PackageInfo): string | undefined {
  const scripts = packageInfo.manifest.scripts ?? {};
  return scripts["test:unit"] ?? scripts.test;
}

export function missingTestCapabilityFindings({
  root,
  packages,
}: DetectorContext): RawFinding[] {
  return packages.flatMap((packageInfo) => {
    if (packageInfo.sourceFiles.length === 0 || selectedTestScript(packageInfo)) return [];
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    const packageLabel = packageInfo.path === "." ? "repository package" : packageInfo.path;
    return [
      {
        subject: {
          kind: "package" as const,
          key: packageInfo.path,
          path: packageInfo.path,
          description: `Package ${packageLabel}`,
        },
        requirement: {
          kind: "check" as const,
          key: "test-capability",
          description: "a deterministic test or test:unit package script",
          expectedArtifact: `${manifestPath}#scripts.test`,
        },
        message: `${packageLabel} contains production TypeScript source but exposes no test capability`,
        evidence: [
          {
            kind: "manifest" as const,
            path: manifestPath,
            detail: `${packageInfo.sourceFiles.length} production TypeScript source file${packageInfo.sourceFiles.length === 1 ? "" : "s"} discovered without test/test:unit script`,
          },
        ],
        relatedFiles: [
          manifestPath,
          ...packageInfo.sourceFiles.map((path) => relativePosix(root, path)),
        ],
        verification: [],
      },
    ];
  });
}

function benchmarkScript(
  packageInfo: PackageInfo,
): { name: string; command: string } | undefined {
  const scripts = packageInfo.manifest.scripts ?? {};
  for (const name of ["benchmark", "benchmark:smoke", "bench"]) {
    const command = scripts[name];
    if (typeof command === "string" && command.trim()) return { name, command };
  }
  return undefined;
}

function hasBenchmarkArtifact(packageInfo: PackageInfo): boolean {
  return walkFiles(packageInfo.directory, 8).some((path) => {
    const local = relativePosix(packageInfo.directory, path);
    return (
      /(?:^|\/)(?:bench|benches|benchmark|benchmarks)\//.test(local) ||
      /\.(?:bench|benchmark)\.(?:[cm]?[jt]sx?|rs)$/.test(local)
    );
  });
}

export function missingBenchmarkEvidenceFindings({
  root,
  packages,
}: DetectorContext): RawFinding[] {
  return packages.flatMap((packageInfo) => {
    const script = benchmarkScript(packageInfo);
    if (!script || hasBenchmarkArtifact(packageInfo)) return [];
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    const packageLabel = packageInfo.path === "." ? "repository package" : packageInfo.path;
    return [
      {
        subject: {
          kind: "package" as const,
          key: packageInfo.path,
          path: packageInfo.path,
          description: `Package ${packageLabel}`,
        },
        requirement: {
          kind: "file" as const,
          key: "benchmark-evidence",
          description: "a conventional benchmark artifact for the declared benchmark capability",
        },
        message: `${packageLabel} declares ${script.name} but no conventional benchmark artifact was found`,
        evidence: [
          {
            kind: "manifest" as const,
            path: manifestPath,
            detail: `scripts.${script.name} = ${JSON.stringify(script.command)}`,
          },
        ],
        relatedFiles: [manifestPath],
        verification: [],
      },
    ];
  });
}
