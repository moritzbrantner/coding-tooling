import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { discoverComponents, loadConfig } from "./core.ts";
import type { Capability, ResultStatus } from "./model.ts";
import { readJson, relativePosix, walkFiles } from "./shared.ts";

export type FindingSeverity = "info" | "warning" | "error";
export type FindingState = "new" | "baseline";
export type FindingRelationshipKind =
  | "requires"
  | "blocks"
  | "related-to"
  | "same-subject"
  | "same-expectation";

export type FindingSubject = {
  kind: "repository" | "package" | "file";
  key: string;
  path?: string;
  description: string;
};

export type FindingRequirement = {
  kind: "test" | "check" | "file" | "wiring" | "signal";
  key: string;
  description: string;
  expectedArtifact?: string;
};

export type FindingEvidence = {
  kind: "file" | "manifest" | "config";
  path: string;
  detail: string;
};

export type FindingRelationship = {
  kind: FindingRelationshipKind;
  targetId: string;
};

export type FindingScaffold = {
  kind: "create-file";
  path: string;
  content: string;
};

export type Finding = {
  id: string;
  expectationId: string;
  severity: FindingSeverity;
  state: FindingState;
  subject: FindingSubject;
  requirement: FindingRequirement;
  message: string;
  evidence: FindingEvidence[];
  relatedFiles: string[];
  verification: string[][];
  relationships: FindingRelationship[];
  scaffold?: FindingScaffold;
};

export type ExpectationSuppression = {
  id?: string;
  expectation?: string;
  subject?: string;
  reason: string;
};

export type RepositoryInvariant = {
  id: string;
  scope: string;
  statement: string;
  verification?: string[][];
};

export type ExpectationConfig = {
  schemaVersion: 1;
  baseline?: string[];
  suppressions?: ExpectationSuppression[];
  invariants?: RepositoryInvariant[];
  enforcement?: Record<string, FindingSeverity>;
};

type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
};

type PackageInfo = {
  directory: string;
  path: string;
  manifestPath: string;
  manifest: PackageManifest;
  files: string[];
  testFiles: string[];
  sourceFiles: string[];
  usesBun: boolean;
};

type RawFinding = Omit<Finding, "id" | "severity" | "state" | "relationships"> & {
  defaultSeverity: FindingSeverity;
};

export type ExpectationOperation = "findings" | "baseline" | "scaffold";

export type ExpectationEnvelope = {
  schemaVersion: 1;
  operation: ExpectationOperation;
  status: ResultStatus;
  durationMs: number;
  data: Record<string, unknown>;
  diagnostics: Array<{ code?: string; message: string; path?: string }>;
};

const expectationConfigName = ".coding-tooling.expectations.json";
const findingIdPattern = /^CT-[A-F0-9]{12}$/;
const severities = new Set<FindingSeverity>(["info", "warning", "error"]);
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const sourceFilePattern = /\.(?:[cm]?ts|tsx)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function assertStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

export function loadExpectationConfig(
  root: string,
  configuredPath = expectationConfigName,
): ExpectationConfig {
  const path = join(root, configuredPath);
  if (!existsSync(path)) return { schemaVersion: 1 };
  const value = readJson<unknown>(path);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`${configuredPath} must use schemaVersion 1`);
  }

  const baseline = assertStringArray(value.baseline, `${configuredPath}.baseline`);
  if (baseline?.some((id) => !findingIdPattern.test(id))) {
    throw new Error(`${configuredPath}.baseline contains an invalid finding ID`);
  }

  let suppressions: ExpectationSuppression[] | undefined;
  if (value.suppressions !== undefined) {
    if (!Array.isArray(value.suppressions)) {
      throw new Error(`${configuredPath}.suppressions must be an array`);
    }
    suppressions = value.suppressions.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.reason !== "string" ||
        !item.reason.trim() ||
        (item.id !== undefined && typeof item.id !== "string") ||
        (item.expectation !== undefined && typeof item.expectation !== "string") ||
        (item.subject !== undefined && typeof item.subject !== "string") ||
        (item.id === undefined && item.expectation === undefined)
      ) {
        throw new Error(`${configuredPath}.suppressions[${index}] is invalid`);
      }
      return {
        id: item.id as string | undefined,
        expectation: item.expectation as string | undefined,
        subject: item.subject as string | undefined,
        reason: item.reason,
      };
    });
  }

  let invariants: RepositoryInvariant[] | undefined;
  if (value.invariants !== undefined) {
    if (!Array.isArray(value.invariants)) {
      throw new Error(`${configuredPath}.invariants must be an array`);
    }
    invariants = value.invariants.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.scope !== "string" ||
        !item.scope ||
        typeof item.statement !== "string" ||
        !item.statement
      ) {
        throw new Error(`${configuredPath}.invariants[${index}] is invalid`);
      }
      let verification: string[][] | undefined;
      if (item.verification !== undefined) {
        if (
          !Array.isArray(item.verification) ||
          !item.verification.every(
            (command) =>
              Array.isArray(command) &&
              command.length > 0 &&
              command.every((part) => typeof part === "string" && part.length > 0),
          )
        ) {
          throw new Error(`${configuredPath}.invariants[${index}].verification is invalid`);
        }
        verification = item.verification as string[][];
      }
      return { id: item.id, scope: item.scope, statement: item.statement, verification };
    });
  }

  let enforcement: Record<string, FindingSeverity> | undefined;
  if (value.enforcement !== undefined) {
    if (!isRecord(value.enforcement)) {
      throw new Error(`${configuredPath}.enforcement must be an object`);
    }
    enforcement = {};
    for (const [expectation, severity] of Object.entries(value.enforcement)) {
      if (typeof severity !== "string" || !severities.has(severity as FindingSeverity)) {
        throw new Error(`${configuredPath}.enforcement.${expectation} has invalid severity`);
      }
      enforcement[expectation] = severity as FindingSeverity;
    }
  }

  return {
    schemaVersion: 1,
    baseline,
    suppressions,
    invariants,
    enforcement,
  };
}

function semanticFindingId(
  expectationId: string,
  subjectKey: string,
  requirementKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${expectationId}\0${subjectKey}\0${requirementKey}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `CT-${digest}`;
}

function packageInfos(root: string): PackageInfo[] {
  const files = walkFiles(root, 8).sort();
  const manifestPaths = files.filter((path) => basename(path) === "package.json");
  const packageDirectories = manifestPaths
    .map((path) => dirname(path))
    .sort((left, right) => right.length - left.length);
  const result: PackageInfo[] = [];
  for (const manifestPath of manifestPaths) {
    const manifest = readJson<PackageManifest>(manifestPath);
    if (!manifest) continue;
    const directory = dirname(manifestPath);
    const packageFiles = files.filter((path) => {
      const owner = packageDirectories.find(
        (candidate) =>
          path === join(candidate, "package.json") || path.startsWith(`${candidate}${sep}`),
      );
      return owner === directory;
    });
    const sourceFiles = packageFiles.filter((path) => {
      const local = normalizePath(relative(directory, path));
      return (
        local.startsWith("src/") &&
        sourceFilePattern.test(local) &&
        !local.endsWith(".d.ts") &&
        !testFilePattern.test(local)
      );
    });
    const testFiles = packageFiles.filter((path) => testFilePattern.test(normalizePath(path)));
    result.push({
      directory,
      path: relativePosix(root, directory),
      manifestPath,
      manifest,
      files: packageFiles,
      testFiles,
      sourceFiles,
      usesBun:
        existsSync(join(directory, "bun.lock")) ||
        existsSync(join(directory, "bun.lockb")) ||
        existsSync(join(root, "bun.lock")) ||
        existsSync(join(root, "bun.lockb")),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function testIdentity(path: string, packageInfo: PackageInfo): string | undefined {
  const local = normalizePath(relative(packageInfo.directory, path));
  const withoutRoot = local.startsWith("tests/")
    ? local.slice(6)
    : local.startsWith("src/")
      ? local.slice(4)
      : local;
  const match = /^(.*)\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.exec(withoutRoot);
  return match?.[1];
}

function sourceIdentity(source: string, packageInfo: PackageInfo): string {
  const local = normalizePath(relative(packageInfo.directory, source));
  const withoutRoot = local.startsWith("src/") ? local.slice(4) : local;
  const extension = extname(withoutRoot);
  return withoutRoot.slice(0, -extension.length);
}

function moduleSpecifiers(content: string): string[] {
  const result: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) result.push(match[1]);
    }
  }
  return result;
}

function testDirectlyReferencesSource(source: string, testFile: string): boolean {
  let content: string;
  try {
    content = readFileSync(testFile, "utf8");
  } catch {
    return false;
  }
  const relativeImport = normalizePath(relative(dirname(testFile), source));
  const specifier = relativeImport.startsWith(".") ? relativeImport : `./${relativeImport}`;
  const extension = extname(specifier);
  const extensionless = extension ? specifier.slice(0, -extension.length) : specifier;
  return moduleSpecifiers(content).some(
    (candidate) => candidate === specifier || candidate === extensionless,
  );
}

function matchingTest(source: string, packageInfo: PackageInfo): string | undefined {
  const identity = sourceIdentity(source, packageInfo);
  return packageInfo.testFiles.find((testFile) => {
    const test = testIdentity(testFile, packageInfo);
    return (
      test === identity ||
      test?.startsWith(`${identity}-`) === true ||
      testDirectlyReferencesSource(source, testFile)
    );
  });
}

function plannedTestPath(root: string, source: string, packageInfo: PackageInfo): string {
  const local = normalizePath(relative(packageInfo.directory, source));
  const withoutSourceRoot = local.startsWith("src/") ? local.slice(4) : local;
  const extension = extname(withoutSourceRoot);
  const stem = withoutSourceRoot.slice(0, -extension.length);
  const testExtension = extension === ".tsx" ? ".tsx" : ".ts";
  return relativePosix(root, join(packageInfo.directory, "tests", `${stem}.test${testExtension}`));
}

function verificationForTest(packageInfo: PackageInfo, root: string, target: string): string[][] {
  const localTarget = normalizePath(relative(packageInfo.directory, join(root, target)));
  if (packageInfo.usesBun) return [["bun", "test", localTarget]];
  if (packageInfo.manifest.scripts?.test) return [["npm", "test", "--", localTarget]];
  return [];
}

function testScaffold(
  source: string,
  target: string,
  packageInfo: PackageInfo,
): FindingScaffold | undefined {
  if (!packageInfo.usesBun) return undefined;
  const sourceLabel = normalizePath(relative(packageInfo.directory, source));
  return {
    kind: "create-file",
    path: target,
    content: `import { describe, test } from "bun:test";\n\ndescribe(${JSON.stringify(sourceLabel)}, () => {\n  test.todo("add deterministic coverage");\n});\n`,
  };
}

function missingTestFindings(root: string, packages: PackageInfo[]): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    const scripts = packageInfo.manifest.scripts ?? {};
    if (!("test" in scripts) && !("test:unit" in scripts)) continue;
    for (const source of packageInfo.sourceFiles) {
      if (matchingTest(source, packageInfo)) continue;
      const sourcePath = relativePosix(root, source);
      const target = plannedTestPath(root, source, packageInfo);
      findings.push({
        expectationId: "typescript-source-test",
        defaultSeverity: "warning",
        subject: {
          kind: "file",
          key: sourcePath,
          path: sourcePath,
          description: `TypeScript source ${sourcePath}`,
        },
        requirement: {
          kind: "test",
          key: target,
          description: "a matching deterministic test artifact",
          expectedArtifact: target,
        },
        message: `${sourcePath} has no matching test artifact`,
        evidence: [{ kind: "file", path: sourcePath, detail: "source file exists" }],
        relatedFiles: [sourcePath],
        verification: verificationForTest(packageInfo, root, target),
        scaffold: testScaffold(source, target, packageInfo),
      });
    }
  }
  return findings;
}

function missingAggregateCheckFindings(root: string, packages: PackageInfo[]): RawFinding[] {
  const candidates = ["format:check", "lint", "typecheck", "test", "test:unit", "build"];
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    const scripts = packageInfo.manifest.scripts ?? {};
    const available = candidates.filter((name) => typeof scripts[name] === "string");
    if (
      available.length < 2 ||
      typeof scripts.check === "string" ||
      typeof scripts.verify === "string"
    )
      continue;
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    findings.push({
      expectationId: "package-aggregate-check",
      defaultSeverity: "warning",
      subject: {
        kind: "package",
        key: packageInfo.path,
        path: manifestPath,
        description: `package ${packageInfo.manifest.name ?? packageInfo.path}`,
      },
      requirement: {
        kind: "check",
        key: "package.json#scripts.check",
        description: "an aggregate check or verify script",
        expectedArtifact: `${manifestPath}#scripts.check`,
      },
      message: `${manifestPath} exposes ${available.length} verification scripts but no aggregate check/verify script`,
      evidence: [
        {
          kind: "manifest",
          path: manifestPath,
          detail: `verification scripts: ${available.sort().join(", ")}`,
        },
      ],
      relatedFiles: [manifestPath],
      verification: packageInfo.usesBun ? [["bun", "run", "check"]] : [["npm", "run", "check"]],
    });
  }
  return findings;
}

function missingTypeScriptConfigFindings(root: string, packages: PackageInfo[]): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    if (
      packageInfo.sourceFiles.length === 0 ||
      existsSync(join(packageInfo.directory, "tsconfig.json"))
    )
      continue;
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    const target = relativePosix(root, join(packageInfo.directory, "tsconfig.json"));
    findings.push({
      expectationId: "typescript-project-config",
      defaultSeverity: "warning",
      subject: {
        kind: "package",
        key: packageInfo.path,
        path: manifestPath,
        description: `TypeScript package ${packageInfo.manifest.name ?? packageInfo.path}`,
      },
      requirement: {
        kind: "file",
        key: target,
        description: "a TypeScript project configuration",
        expectedArtifact: target,
      },
      message: `${packageInfo.path} contains TypeScript source but no tsconfig.json`,
      evidence: packageInfo.sourceFiles.slice(0, 3).map((path) => ({
        kind: "file" as const,
        path: relativePosix(root, path),
        detail: "TypeScript source exists",
      })),
      relatedFiles: [
        manifestPath,
        ...packageInfo.sourceFiles.slice(0, 3).map((path) => relativePosix(root, path)),
      ],
      verification:
        typeof packageInfo.manifest.scripts?.typecheck === "string"
          ? [packageInfo.usesBun ? ["bun", "run", "typecheck"] : ["npm", "run", "typecheck"]]
          : [],
    });
  }
  return findings;
}

function normalizedBinTargets(bin: PackageManifest["bin"]): string[] {
  const values = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/^\.\//, "").replaceAll("\\", "/"));
}

function missingCliWiringFindings(root: string, packages: PackageInfo[]): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    const targets = normalizedBinTargets(packageInfo.manifest.bin);
    const manifestPath = relativePosix(root, packageInfo.manifestPath);
    if (targets.length > 0) {
      for (const target of targets) {
        if (existsSync(join(packageInfo.directory, target))) continue;
        findings.push({
          expectationId: "package-cli-wiring",
          defaultSeverity: "warning",
          subject: {
            kind: "package",
            key: packageInfo.path,
            path: manifestPath,
            description: `package ${packageInfo.manifest.name ?? packageInfo.path}`,
          },
          requirement: {
            kind: "wiring",
            key: `${manifestPath}#bin:${target}`,
            description: "a bin target that resolves to an existing file",
            expectedArtifact: relativePosix(root, join(packageInfo.directory, target)),
          },
          message: `${manifestPath} wires bin target ${target}, but that file does not exist`,
          evidence: [{ kind: "manifest", path: manifestPath, detail: `bin references ${target}` }],
          relatedFiles: [manifestPath],
          verification: [],
        });
      }
      continue;
    }

    const cli = join(packageInfo.directory, "src", "cli.ts");
    if (!existsSync(cli)) continue;
    const cliPath = relativePosix(root, cli);
    findings.push({
      expectationId: "package-cli-wiring",
      defaultSeverity: "warning",
      subject: {
        kind: "file",
        key: cliPath,
        path: cliPath,
        description: `CLI entrypoint ${cliPath}`,
      },
      requirement: {
        kind: "wiring",
        key: `${manifestPath}#bin`,
        description: "package.json bin wiring for the CLI entrypoint",
        expectedArtifact: `${manifestPath}#bin`,
      },
      message: `${cliPath} exists but package.json has no bin wiring`,
      evidence: [
        { kind: "file", path: cliPath, detail: "CLI entrypoint exists" },
        { kind: "manifest", path: manifestPath, detail: "bin is not configured" },
      ],
      relatedFiles: [cliPath, manifestPath],
      verification: [],
    });
  }
  return findings;
}

function missingRequiredCapabilityFindings(root: string): RawFinding[] {
  const config = loadConfig(root);
  const required = config.requiredCapabilities ?? [];
  if (required.length === 0) return [];
  const components = discoverComponents(root);
  const available = new Set<Capability>();
  for (const component of components) {
    const configured = {
      ...component.capabilities,
      ...config.capabilityCommands?.[component.name],
      ...config.capabilityCommands?.[component.path],
    };
    for (const capability of Object.keys(configured) as Capability[]) {
      if (configured[capability]) available.add(capability);
    }
  }

  const configPath = ".coding-tooling.json";
  return required
    .filter((capability) => !available.has(capability))
    .map((capability) => ({
      expectationId: "required-capability-available",
      defaultSeverity: "warning" as const,
      subject: {
        kind: "repository" as const,
        key: ".",
        path: configPath,
        description: "repository verification contract",
      },
      requirement: {
        kind: "signal" as const,
        key: capability,
        description: `configured required capability ${capability}`,
        expectedArtifact: configPath,
      },
      message: `required capability ${capability} is configured but no component provides it`,
      evidence: [
        {
          kind: "config" as const,
          path: configPath,
          detail: `${capability} is listed in requiredCapabilities`,
        },
      ],
      relatedFiles: [configPath],
      verification: [],
    }));
}

function suppressed(finding: Finding, config: ExpectationConfig): boolean {
  return (config.suppressions ?? []).some((suppression) => {
    if (suppression.id && suppression.id !== finding.id) return false;
    if (suppression.expectation && suppression.expectation !== finding.expectationId) return false;
    if (suppression.subject && suppression.subject !== finding.subject.key) return false;
    return true;
  });
}

function materializeFinding(raw: RawFinding, config: ExpectationConfig): Finding {
  const id = semanticFindingId(raw.expectationId, raw.subject.key, raw.requirement.key);
  const { defaultSeverity, ...finding } = raw;
  return {
    ...finding,
    id,
    severity: config.enforcement?.[raw.expectationId] ?? defaultSeverity,
    state: config.baseline?.includes(id) ? "baseline" : "new",
    relationships: [],
  };
}

function addRelationships(findings: Finding[]): Finding[] {
  const bySubject = new Map<string, Finding[]>();
  for (const finding of findings) {
    const current = bySubject.get(finding.subject.key) ?? [];
    current.push(finding);
    bySubject.set(finding.subject.key, current);
  }
  return findings.map((finding) => ({
    ...finding,
    relationships: (bySubject.get(finding.subject.key) ?? [])
      .filter((other) => other.id !== finding.id)
      .map((other) => ({ kind: "same-subject" as const, targetId: other.id }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId)),
  }));
}

export function analyzeExpectations(root: string): {
  findings: Finding[];
  config: ExpectationConfig;
} {
  const config = loadExpectationConfig(root);
  const packages = packageInfos(root);
  const raw = [
    ...missingTestFindings(root, packages),
    ...missingAggregateCheckFindings(root, packages),
    ...missingTypeScriptConfigFindings(root, packages),
    ...missingCliWiringFindings(root, packages),
    ...missingRequiredCapabilityFindings(root),
  ];
  const findings = raw
    .map((item) => materializeFinding(item, config))
    .filter((finding) => !suppressed(finding, config))
    .sort(
      (left, right) =>
        left.subject.key.localeCompare(right.subject.key) ||
        left.expectationId.localeCompare(right.expectationId) ||
        left.id.localeCompare(right.id),
    );
  return { findings: addRelationships(findings), config };
}

function findingCounts(findings: Finding[]): Record<string, number> {
  return {
    total: findings.length,
    new: findings.filter((finding) => finding.state === "new").length,
    baseline: findings.filter((finding) => finding.state === "baseline").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    error: findings.filter((finding) => finding.severity === "error").length,
  };
}

export function findingsCommand(
  root: string,
  options: { state?: FindingState } = {},
): ExpectationEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root);
    const findings = options.state
      ? analysis.findings.filter((finding) => finding.state === options.state)
      : analysis.findings;
    const blocking = analysis.findings.some(
      (finding) => finding.state === "new" && finding.severity === "error",
    );
    return {
      schemaVersion: 1,
      operation: "findings",
      status: blocking ? "failed" : "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        state: options.state ?? "all",
        counts: findingCounts(findings),
        findings,
        invariants: analysis.config.invariants ?? [],
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "findings",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, findings: [] },
      diagnostics: [
        {
          code: "invalid-expectations",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function writeExpectationConfig(root: string, config: ExpectationConfig): void {
  writeFileSync(join(root, expectationConfigName), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function baselineFindings(root: string): ExpectationEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root);
    const baseline = analysis.findings.map((finding) => finding.id).sort();
    writeExpectationConfig(root, { ...analysis.config, baseline });
    return {
      schemaVersion: 1,
      operation: "baseline",
      status: "passed",
      durationMs: Date.now() - started,
      data: { root, baselineCount: baseline.length, baseline },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "baseline",
      status: "error",
      durationMs: Date.now() - started,
      data: { root },
      diagnostics: [
        {
          code: "baseline-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function safeScaffoldTarget(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(root, path);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Scaffold target escapes repository root: ${path}`);
  }
  return target;
}

export function scaffoldFinding(root: string, id: string): ExpectationEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root);
    const finding = analysis.findings.find((item) => item.id === id);
    if (!finding) {
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "unavailable",
        durationMs: Date.now() - started,
        data: { root, id },
        diagnostics: [{ code: "finding-not-found", message: `Finding ${id} is not active` }],
      };
    }
    if (!finding.scaffold) {
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "unavailable",
        durationMs: Date.now() - started,
        data: { root, id, finding },
        diagnostics: [
          { code: "scaffold-unavailable", message: `Finding ${id} has no deterministic scaffold` },
        ],
      };
    }

    const target = safeScaffoldTarget(root, finding.scaffold.path);
    if (existsSync(target)) {
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "unavailable",
        durationMs: Date.now() - started,
        data: { root, id, path: finding.scaffold.path },
        diagnostics: [
          { code: "scaffold-target-exists", message: `${finding.scaffold.path} already exists` },
        ],
      };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, finding.scaffold.content, "utf8");
    const remaining = analyzeExpectations(root).findings.some((item) => item.id === id);
    return {
      schemaVersion: 1,
      operation: "scaffold",
      status: remaining ? "failed" : "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        id,
        path: finding.scaffold.path,
        result: remaining ? "still-active" : "scaffolded",
      },
      diagnostics: remaining
        ? [
            {
              code: "scaffold-incomplete",
              message: `Finding ${id} remains active after scaffolding`,
            },
          ]
        : [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "scaffold",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, id },
      diagnostics: [
        {
          code: "scaffold-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
