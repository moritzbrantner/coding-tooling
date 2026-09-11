import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { ResultEnvelope } from "./model.ts";
import {
  commandAvailable,
  readJson,
  relativePosix,
  runCommand,
  walkFiles,
  type CommandResult,
} from "./shared.ts";

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

export type DependencyResolutionFinding = {
  severity: "error" | "warning";
  code:
    | "consumer-verification-floats-dependencies"
    | "consumer-verification-bypasses-peer-resolution"
    | "declared-peer-contract-unsatisfiable"
    | "fresh-peer-resolution-drift"
    | "locked-development-graph-masks-consumer-failure"
    | "registry-resolution-unavailable"
    | "package-resolution-probe-failed";
  message: string;
  packageName?: string;
  manifestPath: string;
  relatedFiles: string[];
  mode?: "minimum" | "fresh";
  details?: string[];
  remediation: "fix-verifier" | "fix-peer-contract" | "inspect-resolution" | "none";
};

export type StaticConsumerVerificationFinding = Pick<
  DependencyResolutionFinding,
  "severity" | "code" | "message" | "packageName" | "manifestPath" | "relatedFiles" | "remediation"
>;

type CommandRunner = (
  command: string,
  args?: string[],
  cwd?: string,
  inherit?: boolean,
) => CommandResult;

type ResolutionProbe = {
  mode: "minimum" | "fresh";
  status: "passed" | "failed" | "unavailable";
  specs: string[];
  selectedVersions: Record<string, string>;
  exitCode?: number;
  reason?: string;
  details: string[];
};

type PackageResolutionReport = {
  packageName: string;
  manifestPath: string;
  peerDependencies: Record<string, string>;
  optionalPeers: string[];
  repositoryState: {
    status: "observed" | "unavailable";
    lockfiles: string[];
    declaredVersions: Record<string, string>;
    proves: string;
  };
  minimum: ResolutionProbe;
  fresh: ResolutionProbe;
};

type PackageTarget = {
  directory: string;
  manifestPath: string;
  manifest: PackageManifest;
};

const verificationScriptPattern = /consumer|published|package/i;
const floatingSpecPattern = /\b((?:@[\w.-]+\/)?[\w.-]+)@(\^|~|>=|>|\*)[^\s"'`,;&|\]]*/g;
const bypassLinePattern = /\bnpm\b.*\binstall\b.*--(?:force|legacy-peer-deps)\b/i;
const sourceReferencePattern = /\b(?:node|bun)\s+((?:\.\/)?[^\s"';&|]+\.[cm]?[jt]s)\b/g;

function packageName(manifest: PackageManifest, directory: string): string {
  return manifest.name ?? basename(directory);
}

function isContainedPath(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function relevantVerificationSources(
  directory: string,
  manifest: PackageManifest,
): Array<{
  path: string;
  text: string;
}> {
  const packageRoot = resolve(directory);
  const sources: Array<{ path: string; text: string }> = [];
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!verificationScriptPattern.test(name)) continue;
    sources.push({ path: "package.json", text: command });

    sourceReferencePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sourceReferencePattern.exec(command)) !== null) {
      const path = resolve(packageRoot, match[1]!);
      if (!isContainedPath(packageRoot, path) || !existsSync(path)) continue;
      try {
        sources.push({ path: relativePosix(directory, path), text: readFileSync(path, "utf8") });
      } catch {
        // Static inspection is conservative: unreadable referenced files simply do not add evidence.
      }
    }
  }
  return sources;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function inspectConsumerVerificationForPackage(
  root: string,
  directory: string,
): StaticConsumerVerificationFinding[] {
  const manifestPath = join(directory, "package.json");
  const manifest = readJson<PackageManifest>(manifestPath);
  if (!manifest) return [];

  const sources = relevantVerificationSources(directory, manifest);
  const findings: StaticConsumerVerificationFinding[] = [];
  const floatingSpecs: string[] = [];
  const floatingFiles: string[] = [];
  const bypassFiles: string[] = [];

  for (const source of sources) {
    if (!/\bnpm\b/.test(source.text) || !/\binstall\b/.test(source.text)) continue;

    floatingSpecPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = floatingSpecPattern.exec(source.text)) !== null) {
      floatingSpecs.push(match[0]);
      floatingFiles.push(source.path);
    }

    if (source.text.split(/\r?\n/).some((line) => bypassLinePattern.test(line))) {
      bypassFiles.push(source.path);
    }
  }

  if (floatingSpecs.length > 0) {
    findings.push({
      severity: "warning",
      code: "consumer-verification-floats-dependencies",
      packageName: packageName(manifest, directory),
      manifestPath: relativePosix(root, manifestPath),
      relatedFiles: unique([
        relativePosix(root, manifestPath),
        ...floatingFiles.map((path) => relativePosix(root, join(directory, path))),
      ]).sort(),
      remediation: "fix-verifier",
      message: `consumer verification installs floating dependency specs (${unique(floatingSpecs).sort().join(", ")}); derive deterministic exact versions from the declared compatibility contract instead`,
    });
  }

  if (bypassFiles.length > 0) {
    findings.push({
      severity: "error",
      code: "consumer-verification-bypasses-peer-resolution",
      packageName: packageName(manifest, directory),
      manifestPath: relativePosix(root, manifestPath),
      relatedFiles: unique([
        relativePosix(root, manifestPath),
        ...bypassFiles.map((path) => relativePosix(root, join(directory, path))),
      ]).sort(),
      remediation: "fix-verifier",
      message:
        "consumer verification directly invokes npm install with --force or --legacy-peer-deps, so it cannot prove the declared peer contract resolves normally",
    });
  }

  return findings;
}

export function inspectConsumerVerification(root: string): StaticConsumerVerificationFinding[] {
  const manifests = walkFiles(root, 8)
    .filter((path) => basename(path) === "package.json")
    .sort();
  return manifests.flatMap((path) => inspectConsumerVerificationForPackage(root, dirname(path)));
}

function publishableTargets(root: string): PackageTarget[] {
  return walkFiles(root, 8)
    .filter((path) => basename(path) === "package.json")
    .sort()
    .flatMap((manifestPath) => {
      const manifest = readJson<PackageManifest>(manifestPath);
      if (
        !manifest ||
        manifest.private === true ||
        Object.keys(manifest.peerDependencies ?? {}).length === 0
      ) {
        return [];
      }
      return [{ directory: dirname(manifestPath), manifestPath, manifest }];
    });
}

function exactLowerBound(range: string): string | undefined {
  const value = range.trim();
  if (value.includes("||") || value.includes(" - ")) return undefined;
  const match = value.match(/^(?:\^|~|>=\s*)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+<[^\s]+)?$/);
  return match?.[1];
}

function dependencySpecs(
  manifest: PackageManifest,
  mode: "minimum" | "fresh",
): { specs: string[] } | { unavailable: string } {
  const entries = Object.entries(manifest.peerDependencies ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const specs: string[] = [];
  for (const [name, range] of entries) {
    if (mode === "fresh") {
      specs.push(`${name}@${range}`);
      continue;
    }
    const version = exactLowerBound(range);
    if (!version) return { unavailable: `${name} uses unsupported minimum-range syntax: ${range}` };
    specs.push(`${name}@${version}`);
  }
  return { specs };
}

function classifyFailure(result: CommandResult): {
  status: "failed" | "unavailable";
  reason: string;
  details: string[];
} {
  const text = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`;
  const details = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /ERESOLVE|Could not resolve dependency|Found:|peer .+ from |ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(
        line,
      ),
    )
    .slice(0, 12);
  if (/ERESOLVE|unable to resolve dependency tree|Could not resolve dependency/i.test(text)) {
    return { status: "failed", reason: "peer-resolution-conflict", details };
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network request|fetch failed|registry.*unavailable/i.test(
      text,
    )
  ) {
    return { status: "unavailable", reason: "registry-unavailable", details };
  }
  return { status: "failed", reason: "resolver-command-failed", details };
}

function selectedVersions(tempRoot: string, peerNames: string[]): Record<string, string> {
  const lock = readJson<{ packages?: Record<string, { version?: string }> }>(
    join(tempRoot, "package-lock.json"),
  );
  if (!lock?.packages) return {};
  const result: Record<string, string> = {};
  for (const name of peerNames) {
    const version = lock.packages[`node_modules/${name}`]?.version;
    if (version) result[name] = version;
  }
  return result;
}

function runProbe(
  target: PackageTarget,
  packageTarballPath: string,
  mode: "minimum" | "fresh",
  runner: CommandRunner,
): ResolutionProbe {
  const resolution = dependencySpecs(target.manifest, mode);
  if ("unavailable" in resolution) {
    return {
      mode,
      status: "unavailable",
      specs: [],
      selectedVersions: {},
      reason: resolution.unavailable,
      details: [],
    };
  }

  const tempRoot = mkdtempSync(join(tmpdir(), `coding-tooling-dependency-${mode}-`));
  try {
    writeFileSync(
      join(tempRoot, "package.json"),
      JSON.stringify(
        { private: true, name: `coding-tooling-${mode}-consumer`, version: "0.0.0" },
        null,
        2,
      ),
      "utf8",
    );
    const result = runner(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--package-lock-only",
        "--no-audit",
        "--no-fund",
        packageTarballPath,
        ...resolution.specs,
      ],
      tempRoot,
    );
    if (result.status === 0) {
      return {
        mode,
        status: "passed",
        specs: resolution.specs,
        selectedVersions: selectedVersions(
          tempRoot,
          Object.keys(target.manifest.peerDependencies ?? {}),
        ),
        exitCode: 0,
        details: [],
      };
    }
    const failure = classifyFailure(result);
    return {
      mode,
      status: failure.status,
      specs: resolution.specs,
      selectedVersions: {},
      exitCode: result.status,
      reason: failure.reason,
      details: failure.details,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function lockfilesFor(root: string, directory: string): string[] {
  const names = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  return unique(
    names
      .flatMap((name) => [join(directory, name), join(root, name)])
      .filter((path) => existsSync(path)),
  )
    .map((path) => relativePosix(root, path))
    .sort();
}

function repositoryState(
  root: string,
  target: PackageTarget,
): PackageResolutionReport["repositoryState"] {
  const lockfiles = lockfilesFor(root, target.directory);
  const declared = { ...target.manifest.dependencies, ...target.manifest.devDependencies };
  const declaredVersions = Object.fromEntries(
    Object.keys(target.manifest.peerDependencies ?? {})
      .sort()
      .flatMap((name) => (declared[name] ? [[name, declared[name]!]] : [])),
  );
  return {
    status: lockfiles.length > 0 ? "observed" : "unavailable",
    lockfiles,
    declaredVersions,
    proves:
      lockfiles.length > 0
        ? "The repository records a locked development graph; this does not prove fresh consumer resolution."
        : "No supported lockfile was found, so no locked development graph is claimed.",
  };
}

function runtimeFindings(report: PackageResolutionReport): DependencyResolutionFinding[] {
  const findings: DependencyResolutionFinding[] = [];
  const base = {
    packageName: report.packageName,
    manifestPath: report.manifestPath,
    relatedFiles: unique([report.manifestPath, ...report.repositoryState.lockfiles]).sort(),
  };

  if (report.minimum.status === "failed" && report.minimum.reason === "peer-resolution-conflict") {
    findings.push({
      ...base,
      severity: "error",
      code: "declared-peer-contract-unsatisfiable",
      mode: "minimum",
      details: report.minimum.details,
      remediation: "fix-peer-contract",
      message:
        "the declared peer dependency contract cannot be installed even at its deterministic minimum compatibility point",
    });
  }

  if (
    report.minimum.status === "passed" &&
    report.fresh.status === "failed" &&
    report.fresh.reason === "peer-resolution-conflict"
  ) {
    findings.push({
      ...base,
      severity: "error",
      code: "fresh-peer-resolution-drift",
      mode: "fresh",
      details: report.fresh.details,
      remediation: "inspect-resolution",
      message:
        "a clean consumer using the declared ranges now resolves to a mutually incompatible peer dependency graph",
    });
  }

  if (report.fresh.status === "failed" && report.repositoryState.status === "observed") {
    findings.push({
      ...base,
      severity: "warning",
      code: "locked-development-graph-masks-consumer-failure",
      mode: "fresh",
      details: report.fresh.details,
      remediation: "inspect-resolution",
      message:
        "the repository has a locked development graph while fresh consumer resolution fails; local green checks are not proof of the published consumer contract",
    });
  }

  for (const probe of [report.minimum, report.fresh]) {
    if (probe.status === "unavailable" && probe.reason === "registry-unavailable") {
      findings.push({
        ...base,
        severity: "warning",
        code: "registry-resolution-unavailable",
        mode: probe.mode,
        details: probe.details,
        remediation: "none",
        message: `${probe.mode} consumer resolution could not reach the package registry; no compatibility result is claimed`,
      });
    } else if (probe.status === "failed" && probe.reason === "resolver-command-failed") {
      findings.push({
        ...base,
        severity: "error",
        code: "package-resolution-probe-failed",
        mode: probe.mode,
        details: probe.details,
        remediation: "inspect-resolution",
        message: `${probe.mode} consumer resolution failed for a reason that was not a recognized peer conflict`,
      });
    }
  }

  return findings;
}

function unavailableProbe(mode: "minimum" | "fresh", reason: string): ResolutionProbe {
  return { mode, status: "unavailable", specs: [], selectedVersions: {}, reason, details: [] };
}

export function resolveDependencies(
  root: string,
  options: {
    execute?: boolean;
    strict?: boolean;
    runner?: CommandRunner;
    npmAvailable?: boolean;
  } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  const execute = options.execute !== false;
  const strict = options.strict === true;
  const staticFindings = inspectConsumerVerification(root);
  const targets = publishableTargets(root);
  const runner = options.runner ?? runCommand;
  const npmReady = options.npmAvailable ?? commandAvailable("npm");
  const reports: PackageResolutionReport[] = [];
  const findings: DependencyResolutionFinding[] = [...staticFindings];

  if (execute && targets.length > 0 && !npmReady) {
    for (const target of targets) {
      const report: PackageResolutionReport = {
        packageName: packageName(target.manifest, target.directory),
        manifestPath: relativePosix(root, target.manifestPath),
        peerDependencies: target.manifest.peerDependencies ?? {},
        optionalPeers: Object.entries(target.manifest.peerDependenciesMeta ?? {})
          .filter(([, meta]) => meta.optional === true)
          .map(([name]) => name)
          .sort(),
        repositoryState: repositoryState(root, target),
        minimum: unavailableProbe("minimum", "npm-unavailable"),
        fresh: unavailableProbe("fresh", "npm-unavailable"),
      };
      reports.push(report);
      findings.push({
        severity: "warning",
        code: "registry-resolution-unavailable",
        packageName: report.packageName,
        manifestPath: report.manifestPath,
        relatedFiles: [report.manifestPath],
        remediation: "none",
        message: "npm is unavailable, so clean consumer dependency resolution was not executed",
      });
    }
  } else if (execute) {
    for (const target of targets) {
      const manifestPath = relativePosix(root, target.manifestPath);
      const pack = runner("npm", ["pack", "--ignore-scripts", "--json"], target.directory);
      if (pack.status !== 0) {
        const failure = classifyFailure(pack);
        const unavailable = failure.status === "unavailable";
        const report: PackageResolutionReport = {
          packageName: packageName(target.manifest, target.directory),
          manifestPath,
          peerDependencies: target.manifest.peerDependencies ?? {},
          optionalPeers: Object.entries(target.manifest.peerDependenciesMeta ?? {})
            .filter(([, meta]) => meta.optional === true)
            .map(([name]) => name)
            .sort(),
          repositoryState: repositoryState(root, target),
          minimum: unavailableProbe("minimum", failure.reason),
          fresh: unavailableProbe("fresh", failure.reason),
        };
        reports.push(report);
        findings.push({
          severity: unavailable ? "warning" : "error",
          code: unavailable ? "registry-resolution-unavailable" : "package-resolution-probe-failed",
          packageName: report.packageName,
          manifestPath,
          relatedFiles: [manifestPath],
          details: failure.details,
          remediation: unavailable ? "none" : "inspect-resolution",
          message: unavailable
            ? "the package resolution probe could not access required registry inputs; no compatibility result is claimed"
            : "the package could not be packed for clean consumer dependency resolution",
        });
        continue;
      }

      let filename: string | undefined;
      try {
        const metadata = JSON.parse(pack.stdout) as Array<{ filename?: string }>;
        filename = metadata[0]?.filename;
      } catch {
        filename = undefined;
      }
      if (!filename) {
        const report: PackageResolutionReport = {
          packageName: packageName(target.manifest, target.directory),
          manifestPath,
          peerDependencies: target.manifest.peerDependencies ?? {},
          optionalPeers: [],
          repositoryState: repositoryState(root, target),
          minimum: unavailableProbe("minimum", "invalid-pack-output"),
          fresh: unavailableProbe("fresh", "invalid-pack-output"),
        };
        reports.push(report);
        findings.push({
          severity: "error",
          code: "package-resolution-probe-failed",
          packageName: report.packageName,
          manifestPath,
          relatedFiles: [manifestPath],
          remediation: "inspect-resolution",
          message: "npm pack did not return a tarball filename for the clean consumer probe",
        });
        continue;
      }

      const packageTarballPath = join(target.directory, filename);
      try {
        const report: PackageResolutionReport = {
          packageName: packageName(target.manifest, target.directory),
          manifestPath,
          peerDependencies: target.manifest.peerDependencies ?? {},
          optionalPeers: Object.entries(target.manifest.peerDependenciesMeta ?? {})
            .filter(([, meta]) => meta.optional === true)
            .map(([name]) => name)
            .sort(),
          repositoryState: repositoryState(root, target),
          minimum: runProbe(target, packageTarballPath, "minimum", runner),
          fresh: runProbe(target, packageTarballPath, "fresh", runner),
        };
        reports.push(report);
        findings.push(...runtimeFindings(report));
      } finally {
        rmSync(packageTarballPath, { force: true });
      }
    }
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const runtimeUnavailable =
    execute &&
    reports.some((report) =>
      [report.minimum, report.fresh].some((probe) => probe.status === "unavailable"),
    );
  const status =
    errors > 0 || (strict && warnings > 0)
      ? "failed"
      : runtimeUnavailable
        ? "unavailable"
        : "passed";

  return {
    schemaVersion: 1,
    operation: "dependencies",
    status,
    durationMs: Math.round(performance.now() - started),
    data: {
      mode: execute ? "runtime" : "static",
      applicable: targets.length > 0,
      runtimeEvidence: execute ? "requested" : "not-run",
      packages: reports,
      findings,
      errors,
      warnings,
      strict,
      proofBoundary: {
        repositoryState:
          "Observes manifest and lockfile state only; it is not fresh-consumer proof.",
        minimum: "Uses exact conservative lower bounds derived from declared peer ranges.",
        fresh:
          "Uses the real npm resolver against current registry state and declared peer ranges.",
      },
    },
    diagnostics: findings.map((finding) => ({
      code: finding.code,
      message: finding.message,
      path: finding.manifestPath,
    })),
  };
}
