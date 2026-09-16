import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { loadConfig } from "./core.ts";
import type { DetectorContext, PackageInfo } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { readJson, relativePosix, walkFiles } from "./shared.ts";

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
const debtMarkerPattern =
  /^\s*(?:\/{2,}|#+|\/\*+|\*+)\s*(?:TODO(?!:\s*\[coding-tooling:|\(coding-tooling:)|FIXME)\b/i;
const workMarkerPatterns = [
  /^\s*(?:\/{2,}|#+|\/\*+|\*+)\s*TODO:\s*\[coding-tooling:([a-z0-9][a-z0-9-]{0,63})\]\s+(.+?)\s*(?:\*\/)?$/i,
  /^\s*(?:\/{2,}|#+|\/\*+|\*+)\s*TODO\(coding-tooling:([a-z0-9][a-z0-9-]{0,63})\):\s*(.+?)\s*(?:\*\/)?$/i,
];
const workMarkerCandidatePattern =
  /^\s*(?:\/{2,}|#+|\/\*+|\*+)\s*TODO(?::\s*\[coding-tooling:|\(coding-tooling:)/i;
const unimplementedPatterns = [
  /\b(?:todo|unimplemented)!\s*\(/,
  /\bthrow\s+new\s+NotImplementedException\s*\(/,
  /\bthrow\s+new\s+Error\s*\(\s*["'`]Not implemented\b/i,
];

function sourceFiles(root: string, includeTests: boolean): string[] {
  return walkFiles(root, 8)
    .filter((path) => {
      const local = relativePosix(root, path);
      if (!sourceExtensions.has(extname(local))) return false;
      if (local.endsWith(".d.ts")) return false;
      if (!includeTests && (testPathPattern.test(local) || testFilePattern.test(local)))
        return false;
      if (storyFilePattern.test(local) || generatedPathPattern.test(local)) return false;
      return true;
    })
    .sort();
}

export function productionSourceFiles(root: string): string[] {
  return sourceFiles(root, false);
}

export function workMarkerSourceFiles(root: string): string[] {
  return sourceFiles(root, true);
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

type WorkMarker =
  | {
      kind: "valid";
      key: string;
      instruction: string;
      line: number;
    }
  | {
      kind: "malformed";
      line: number;
    };

function workMarkers(content: string): WorkMarker[] {
  return content.split(/\r?\n/).flatMap<WorkMarker>((line, index) => {
    const match = workMarkerPatterns
      .map((pattern) => pattern.exec(line))
      .find((candidate) => candidate?.[1] && candidate[2]?.trim());
    if (match?.[1] && match[2]?.trim()) {
      return [
        {
          kind: "valid" as const,
          key: match[1].toLowerCase(),
          instruction: match[2].trim(),
          line: index + 1,
        },
      ];
    }
    if (workMarkerCandidatePattern.test(line)) {
      return [{ kind: "malformed" as const, line: index + 1 }];
    }
    return [];
  });
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

export function sourceWorkMarkerFindings({ root }: DetectorContext): RawFinding[] {
  return workMarkerSourceFiles(root).flatMap((path) => {
    const content = readSource(path);
    if (content === undefined) return [];
    const sourcePath = relativePosix(root, path);
    return workMarkers(content).map((marker) => {
      if (marker.kind === "malformed") {
        return {
          subject: {
            kind: "file" as const,
            key: `${sourcePath}#coding-tooling:malformed:${marker.line}`,
            path: sourcePath,
            description: `Malformed coding-tooling work marker in ${sourcePath}:${marker.line}`,
          },
          requirement: {
            kind: "signal" as const,
            key: "repair-malformed-work-marker",
            description:
              "use TODO: [coding-tooling:<key>] <instruction> or TODO(coding-tooling:<key>): <instruction>",
          },
          message: "Malformed coding-tooling TODO marker",
          evidence: [
            {
              kind: "file" as const,
              path: sourcePath,
              detail: `coding-tooling TODO marker on line ${marker.line} is malformed`,
            },
          ],
          relatedFiles: [sourcePath],
          verification: [],
        };
      }

      return {
        subject: {
          kind: "file" as const,
          key: `${sourcePath}#coding-tooling:${marker.key}`,
          path: sourcePath,
          description: `Work marker ${marker.key} in ${sourcePath}:${marker.line}`,
        },
        requirement: {
          kind: "signal" as const,
          key: `resolve-work-marker:${marker.key}`,
          description: marker.instruction,
        },
        message: marker.instruction,
        evidence: [
          {
            kind: "file" as const,
            path: sourcePath,
            detail: `TODO: [coding-tooling:${marker.key}] on line ${marker.line}: ${marker.instruction}`,
          },
        ],
        relatedFiles: [sourcePath],
        verification: [],
      };
    });
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

export function missingTestCapabilityFindings({ root, packages }: DetectorContext): RawFinding[] {
  return packages.flatMap((packageInfo) => {
    const sourceFiles = [...packageInfo.sourceFiles, ...packageInfo.javaScriptSourceFiles];
    if (sourceFiles.length === 0 || selectedTestScript(packageInfo)) return [];
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
        message: `${packageLabel} contains production JavaScript/TypeScript source but exposes no test capability`,
        evidence: [
          {
            kind: "manifest" as const,
            path: manifestPath,
            detail: `${sourceFiles.length} production JavaScript/TypeScript source file${sourceFiles.length === 1 ? "" : "s"} discovered without test/test:unit script`,
          },
        ],
        relatedFiles: [manifestPath, ...sourceFiles.map((path) => relativePosix(root, path))],
        verification: [],
      },
    ];
  });
}

function benchmarkScript(packageInfo: PackageInfo): { name: string; command: string } | undefined {
  const scripts = packageInfo.manifest.scripts ?? {};
  for (const name of ["benchmark", "benchmark:smoke", "bench"]) {
    const command = scripts[name];
    if (typeof command === "string" && command.trim()) return { name, command };
  }
  return undefined;
}

function commandReferencesExistingBenchmarkArtifact(
  packageInfo: PackageInfo,
  command: string,
): boolean {
  return command.split(/\s+/).some((rawToken) => {
    const token = rawToken.replace(/^["'`]|["'`]$/g, "");
    if (!sourceExtensions.has(extname(token))) return false;
    const candidate = resolve(packageInfo.directory, token);
    const local = relativePosix(packageInfo.directory, candidate);
    if (local === ".." || local.startsWith("../")) return false;
    return existsSync(candidate);
  });
}

function hasBenchmarkArtifact(packageInfo: PackageInfo, command: string): boolean {
  if (commandReferencesExistingBenchmarkArtifact(packageInfo, command)) return true;
  return walkFiles(packageInfo.directory, 8).some((path) => {
    const local = relativePosix(packageInfo.directory, path);
    return (
      /(?:^|\/)(?:bench|benches|benchmark|benchmarks)\//.test(local) ||
      /\.(?:bench|benchmark)\.(?:[cm]?[jt]sx?|rs)$/.test(local)
    );
  });
}

const performanceScenarioKinds = new Set([
  "common",
  "idle",
  "scaling",
  "stress",
  "journey",
  "micro",
]);
const performanceDirections = new Set(["lower", "higher"]);
const performanceSignals = new Set([
  "operation-count",
  "allocation-count",
  "instruction-count",
  "cache-event-count",
  "wall-clock",
  "memory",
  "size",
  "throughput",
  "custom",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function performanceContractValidationError(value: unknown): string | undefined {
  const contract = record(value);
  if (!contract) return "contract root must be an object";
  if (contract.schemaVersion !== 1) return "schemaVersion must equal 1";
  if (!nonEmptyString(contract.suite)) return "suite must be a non-empty string";
  if (!Array.isArray(contract.scenarios) || contract.scenarios.length === 0)
    return "scenarios must be a non-empty array";

  for (const [scenarioIndex, rawScenario] of contract.scenarios.entries()) {
    const scenario = record(rawScenario);
    const prefix = `scenarios[${scenarioIndex}]`;
    if (!scenario) return `${prefix} must be an object`;
    if (!nonEmptyString(scenario.id) || !/^[a-z0-9][a-z0-9-]*$/.test(scenario.id))
      return `${prefix}.id must be a kebab-case identifier`;
    if (!performanceScenarioKinds.has(String(scenario.kind)))
      return `${prefix}.kind is not supported`;
    if (!nonEmptyString(scenario.description))
      return `${prefix}.description must be a non-empty string`;
    if (!record(scenario.dimensions)) return `${prefix}.dimensions must be an object`;
    if (!Array.isArray(scenario.metrics) || scenario.metrics.length === 0)
      return `${prefix}.metrics must be a non-empty array`;

    for (const [metricIndex, rawMetric] of scenario.metrics.entries()) {
      const metric = record(rawMetric);
      const metricPrefix = `${prefix}.metrics[${metricIndex}]`;
      if (!metric) return `${metricPrefix} must be an object`;
      if (!nonEmptyString(metric.name)) return `${metricPrefix}.name must be a non-empty string`;
      if (!nonEmptyString(metric.unit)) return `${metricPrefix}.unit must be a non-empty string`;
      if (!performanceDirections.has(String(metric.direction)))
        return `${metricPrefix}.direction must be lower or higher`;
      if (!performanceSignals.has(String(metric.signal)))
        return `${metricPrefix}.signal is not supported`;
      if (typeof metric.blocking !== "boolean")
        return `${metricPrefix}.blocking must be boolean`;
      if (metric.blocking === true && metric.signal === "wall-clock" && !nonEmptyString(metric.notes))
        return `${metricPrefix} uses blocking wall-clock evidence without documenting the controlled execution boundary`;
    }
  }
  return undefined;
}

function requiredPerformanceContractFindings(root: string): RawFinding[] {
  const configPath = join(root, ".coding-tooling.json");
  if (!existsSync(configPath)) return [];
  const config = loadConfig(root);
  if (!(config.requiredCapabilities ?? []).includes("benchmark:smoke")) return [];

  const relativeConfigPath = ".coding-tooling.json";
  const contractPath = join(root, ".performance", "contract.json");
  const relativeContractPath = ".performance/contract.json";
  if (!existsSync(contractPath)) {
    return [
      {
        subject: {
          kind: "file" as const,
          key: relativeConfigPath,
          path: relativeConfigPath,
          description: "coding-tooling repository configuration",
        },
        requirement: {
          kind: "file" as const,
          key: "performance-contract",
          description:
            "a .performance/contract.json for repositories that require benchmark:smoke",
          expectedArtifact: relativeContractPath,
        },
        message: "benchmark:smoke is required but .performance/contract.json is missing",
        evidence: [
          {
            kind: "file" as const,
            path: relativeConfigPath,
            detail: "requiredCapabilities includes benchmark:smoke",
          },
        ],
        relatedFiles: [relativeConfigPath],
        verification: [],
      },
    ];
  }

  const contract = readJson<unknown>(contractPath);
  const validationError = performanceContractValidationError(contract);
  if (!validationError) return [];
  return [
    {
      subject: {
        kind: "file" as const,
        key: relativeContractPath,
        path: relativeContractPath,
        description: "repository performance contract",
      },
      requirement: {
        kind: "file" as const,
        key: "performance-contract",
        description: "a structurally valid performance contract v1",
        expectedArtifact: relativeContractPath,
      },
      message: `Invalid performance contract: ${validationError}`,
      evidence: [
        {
          kind: "file" as const,
          path: relativeContractPath,
          detail: validationError,
        },
      ],
      relatedFiles: [relativeConfigPath, relativeContractPath],
      verification: [],
    },
  ];
}

export function missingBenchmarkEvidenceFindings({
  root,
  packages,
}: DetectorContext): RawFinding[] {
  const packageFindings = packages.flatMap((packageInfo) => {
    const script = benchmarkScript(packageInfo);
    if (!script || hasBenchmarkArtifact(packageInfo, script.command)) return [];
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
  return [...packageFindings, ...requiredPerformanceContractFindings(root)];
}
