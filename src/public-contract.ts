import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { check, discoverComponents, loadConfig } from "./core.ts";
import {
  capabilities,
  type Capability,
  type Diagnostic,
  type ResultEnvelope,
  type ResultStatus,
} from "./model.ts";
import { readJson, relativePosix, runCommand, walkFiles } from "./shared.ts";

export type PublicContractEvidenceKind =
  | "behavioral"
  | "contract"
  | "render"
  | "interaction"
  | "accessibility"
  | "visual"
  | "package"
  | "compile"
  | "reachability";

export type PublicContractSurfaceKind =
  | "package-export"
  | "cli-command"
  | "http-operation"
  | "rust-crate"
  | "dotnet-assembly"
  | "github-action"
  | "reusable-workflow";

export type PublicContractDiscoveryStatus = "complete" | "partial";

export type PublicContractSurface = {
  id: string;
  kind: PublicContractSurfaceKind;
  component: string;
  subject: string;
  discovery: {
    status: PublicContractDiscoveryStatus;
    reason?: string;
  };
};

export type PublicContractVerification = {
  id: string;
  surface: string;
  kind: PublicContractEvidenceKind;
  capability: Capability;
  component?: string;
  reason?: string;
};

export type PublicContractManifest = {
  schemaVersion: 1;
  verifications?: PublicContractVerification[];
};

export type PublicContractEvidence = PublicContractVerification & {
  component: string;
  outcome: ResultStatus;
};

export type PublicContractSurfaceResult = PublicContractSurface & {
  status: "verified" | "unverified";
  evidence: PublicContractEvidence[];
};

export type PublicContractReport = {
  schemaVersion: 1;
  revision?: string;
  enforcement: "observe" | "protect-new" | "strict";
  manifestPath: string;
  summary: {
    discovered: number;
    verified: number;
    unverified: number;
    incompleteDiscovery: number;
    failedEvidence: number;
    unavailableEvidence: number;
    errorEvidence: number;
    verifiedRatio: number | null;
    strictReady: boolean;
  };
  surfaces: PublicContractSurfaceResult[];
  unsupportedAnalyzers: string[];
};

type PackageManifest = {
  name?: string;
  private?: boolean;
  exports?: unknown;
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, unknown>>;
};

const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const strongEvidence = new Set<PublicContractEvidenceKind>([
  "behavioral",
  "contract",
  "render",
  "interaction",
  "accessibility",
  "visual",
  "package",
  "compile",
]);
const evidenceKinds: readonly PublicContractEvidenceKind[] = [
  "behavioral",
  "contract",
  "render",
  "interaction",
  "accessibility",
  "visual",
  "package",
  "compile",
  "reachability",
];
const evidenceCapabilities: Record<PublicContractEvidenceKind, readonly Capability[]> = {
  behavioral: ["test", "test:unit", "test:integration", "test:e2e", "test:e2e:smoke"],
  contract: [
    "test",
    "test:unit",
    "test:integration",
    "test:e2e",
    "test:e2e:smoke",
    "package:check",
    "template:smoke",
  ],
  render: ["test:e2e", "test:e2e:smoke", "test:visual", "storybook:check"],
  interaction: ["test:e2e", "test:e2e:smoke"],
  accessibility: ["test:accessibility", "web:audit"],
  visual: ["test:visual", "test:e2e", "test:e2e:smoke"],
  package: ["package:check", "template:smoke"],
  compile: ["build", "typecheck", "package:check"],
  reachability: [
    "test",
    "test:unit",
    "test:integration",
    "test:e2e",
    "test:e2e:smoke",
    "build",
    "typecheck",
  ],
};

function surfaceId(kind: PublicContractSurfaceKind, ...parts: string[]): string {
  return [kind, ...parts].map((part) => encodeURIComponent(part)).join(":");
}

function packageExportKeys(value: unknown): string[] {
  if (typeof value === "string" || Array.isArray(value)) return ["."];
  if (!value || typeof value !== "object") return [];
  const keys = Object.keys(value as Record<string, unknown>);
  const explicit = keys.filter((key) => key.startsWith("."));
  return explicit.length > 0 ? explicit.sort() : ["."];
}

function packageSurfaces(root: string): PublicContractSurface[] {
  const surfaces: PublicContractSurface[] = [];
  for (const file of walkFiles(root, 4).filter((path) => basename(path) === "package.json")) {
    const manifest = readJson<PackageManifest>(file);
    if (!manifest) continue;
    const component = relativePosix(root, dirname(file));
    const name = manifest.name ?? (component === "." ? basename(root) : basename(dirname(file)));
    const exports = packageExportKeys(manifest.exports);
    if (exports.length === 0 && (manifest.main || manifest.module || manifest.types))
      exports.push(".");
    for (const exported of exports) {
      surfaces.push({
        id: surfaceId("package-export", name, exported),
        kind: "package-export",
        component,
        subject: `${name}${exported === "." ? "" : exported.slice(1)}`,
        discovery: { status: "complete" },
      });
    }

    const bins =
      typeof manifest.bin === "string"
        ? [name]
        : manifest.bin && typeof manifest.bin === "object"
          ? Object.keys(manifest.bin).sort()
          : [];
    for (const bin of bins) {
      surfaces.push({
        id: surfaceId("cli-command", bin),
        kind: "cli-command",
        component,
        subject: bin,
        discovery: {
          status: "partial",
          reason:
            "The executable is discovered from package metadata; subcommands and flags are not enumerated yet.",
        },
      });
    }
  }
  return surfaces;
}

function cargoPackageName(content: string, fallback: string): string {
  const packageSection = content.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  return packageSection.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? fallback;
}

function rustSurfaces(root: string): PublicContractSurface[] {
  const surfaces: PublicContractSurface[] = [];
  for (const file of walkFiles(root, 4).filter((path) => basename(path) === "Cargo.toml")) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const directory = dirname(file);
    const component = relativePosix(root, directory);
    const name = cargoPackageName(
      content,
      component === "." ? basename(root) : basename(directory),
    );
    if (existsSync(join(directory, "src", "lib.rs")) || /^\s*\[lib\]/m.test(content)) {
      surfaces.push({
        id: surfaceId("rust-crate", name),
        kind: "rust-crate",
        component,
        subject: name,
        discovery: {
          status: "partial",
          reason:
            "The public crate boundary is known, but item-level rustdoc public API discovery is not implemented yet.",
        },
      });
    }
  }
  return surfaces;
}

function dotnetSurfaces(root: string): PublicContractSurface[] {
  const surfaces: PublicContractSurface[] = [];
  const files = walkFiles(root, 4).filter((path) => path.endsWith(".csproj"));
  for (const file of files) {
    const component = relativePosix(root, dirname(file));
    const name = basename(file, ".csproj");
    surfaces.push({
      id: surfaceId("dotnet-assembly", name),
      kind: "dotnet-assembly",
      component,
      subject: name,
      discovery: {
        status: "partial",
        reason:
          "The assembly boundary is known, but item-level ApiCompat surface discovery is not implemented yet.",
      },
    });
  }
  return surfaces;
}

function owningComponent(root: string, file: string): string {
  const relative = relativePosix(root, file);
  const candidates = discoverComponents(root)
    .filter((component) =>
      component.path === "." ? true : relative.startsWith(`${component.path}/`),
    )
    .sort((left, right) => right.path.length - left.path.length);
  return candidates[0]?.path ?? ".";
}

function openApiSurfaces(root: string): PublicContractSurface[] {
  const surfaces: PublicContractSurface[] = [];
  const files = walkFiles(root, 5).filter((path) => {
    const name = basename(path).toLowerCase();
    return (
      name.endsWith(".json") &&
      (name === "openapi.json" || name === "swagger.json" || name.startsWith("openapi."))
    );
  });
  for (const file of files) {
    const document = readJson<OpenApiDocument>(file);
    if (!document?.paths) continue;
    const component = owningComponent(root, file);
    for (const path of Object.keys(document.paths).sort()) {
      const operations = document.paths[path];
      if (!operations || typeof operations !== "object") continue;
      for (const method of Object.keys(operations)
        .filter((value) => httpMethods.has(value.toLowerCase()))
        .sort()) {
        const upper = method.toUpperCase();
        surfaces.push({
          id: surfaceId("http-operation", upper, path),
          kind: "http-operation",
          component,
          subject: `${upper} ${path}`,
          discovery: { status: "complete" },
        });
      }
    }
  }
  return surfaces;
}

function githubSurfaces(root: string): PublicContractSurface[] {
  const surfaces: PublicContractSurface[] = [];
  for (const action of ["action.yml", "action.yaml"]) {
    if (!existsSync(join(root, action))) continue;
    surfaces.push({
      id: surfaceId("github-action", "."),
      kind: "github-action",
      component: ".",
      subject: ".",
      discovery: {
        status: "partial",
        reason:
          "The action boundary is known, but action inputs and outputs are not enumerated yet.",
      },
    });
    break;
  }

  for (const file of walkFiles(join(root, ".github", "workflows"), 1).filter((path) =>
    /\.ya?ml$/i.test(path),
  )) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!/^\s*workflow_call\s*:/m.test(content)) continue;
    const relative = relativePosix(root, file);
    surfaces.push({
      id: surfaceId("reusable-workflow", relative),
      kind: "reusable-workflow",
      component: ".",
      subject: relative,
      discovery: {
        status: "partial",
        reason:
          "The reusable workflow boundary is known, but workflow_call inputs, secrets, and outputs are not enumerated yet.",
      },
    });
  }
  return surfaces;
}

export function discoverPublicContract(root: string): PublicContractSurface[] {
  const unique = new Map<string, PublicContractSurface>();
  for (const surface of [
    ...packageSurfaces(root),
    ...openApiSurfaces(root),
    ...rustSurfaces(root),
    ...dotnetSurfaces(root),
    ...githubSurfaces(root),
  ]) {
    if (!unique.has(surface.id)) unique.set(surface.id, surface);
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function validateRepositoryPath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error(`Public contract manifest path must stay inside the repository: ${path}`);
}

function loadManifest(root: string, path: string): PublicContractManifest {
  validateRepositoryPath(path);
  if (!existsSync(join(root, path))) return { schemaVersion: 1, verifications: [] };
  const manifest = readJson<PublicContractManifest>(join(root, path));
  if (!manifest || manifest.schemaVersion !== 1)
    throw new Error(`${path} must use schemaVersion 1`);
  return manifest;
}

function validateVerifications(
  verifications: PublicContractVerification[],
  surfaces: PublicContractSurface[],
): void {
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const ids = new Set<string>();
  for (const verification of verifications) {
    if (!verification.id?.trim())
      throw new Error("Public contract verification id must not be empty");
    if (ids.has(verification.id))
      throw new Error(`Duplicate public contract verification id: ${verification.id}`);
    ids.add(verification.id);
    if (!surfaceIds.has(verification.surface))
      throw new Error(`Unknown public contract surface: ${verification.surface}`);
    if (!evidenceKinds.includes(verification.kind))
      throw new Error(`Unknown public contract evidence kind: ${verification.kind}`);
    if (!capabilities.includes(verification.capability))
      throw new Error(`Unknown public contract capability: ${verification.capability}`);
    if (!evidenceCapabilities[verification.kind].includes(verification.capability)) {
      throw new Error(
        `Public contract evidence kind '${verification.kind}' cannot use capability '${verification.capability}'`,
      );
    }
  }
}

function revision(root: string): string | undefined {
  const result = runCommand("git", ["rev-parse", "HEAD"], root);
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function reportEnvelope(
  status: ResultStatus,
  started: number,
  report: PublicContractReport,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "contract",
    status,
    durationMs: Date.now() - started,
    data: report as unknown as Record<string, unknown>,
    diagnostics,
  };
}

export function publicContractCommand(
  root: string,
  options: {
    configPath?: string;
    execute?: boolean;
  } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const configPath = options.configPath ?? ".coding-tooling.json";
  try {
    const config = loadConfig(root, configPath);
    const enforcement = config.contracts?.enforcement ?? "observe";
    if (!["observe", "protect-new", "strict"].includes(enforcement))
      throw new Error(`Unknown public contract enforcement mode: ${String(enforcement)}`);
    const manifestPath = config.contracts?.manifest ?? ".coding-tooling.contracts.json";
    const surfaces = discoverPublicContract(root);
    const manifest = loadManifest(root, manifestPath);
    const verifications = manifest.verifications ?? [];
    validateVerifications(verifications, surfaces);
    const bySurface = new Map<string, PublicContractEvidence[]>();
    const executions = new Map<string, ResultStatus>();

    if (options.execute !== false) {
      for (const verification of verifications) {
        const surface = surfaces.find((candidate) => candidate.id === verification.surface)!;
        const component = verification.component ?? surface.component;
        const key = `${component}\u0000${verification.capability}`;
        if (!executions.has(key))
          executions.set(key, check(root, verification.capability, component).status);
        const evidence: PublicContractEvidence = {
          ...verification,
          component,
          outcome: executions.get(key)!,
        };
        bySurface.set(verification.surface, [
          ...(bySurface.get(verification.surface) ?? []),
          evidence,
        ]);
      }
    } else {
      for (const verification of verifications) {
        const surface = surfaces.find((candidate) => candidate.id === verification.surface)!;
        const component = verification.component ?? surface.component;
        bySurface.set(verification.surface, [
          ...(bySurface.get(verification.surface) ?? []),
          { ...verification, component, outcome: "unavailable" },
        ]);
      }
    }

    const results: PublicContractSurfaceResult[] = surfaces.map((surface) => {
      const evidence = bySurface.get(surface.id) ?? [];
      const verified = evidence.some(
        (item) => item.outcome === "passed" && strongEvidence.has(item.kind),
      );
      return { ...surface, status: verified ? "verified" : "unverified", evidence };
    });
    const verified = results.filter((surface) => surface.status === "verified").length;
    const unverified = results.length - verified;
    const incompleteDiscovery = results.filter(
      (surface) => surface.discovery.status === "partial",
    ).length;
    const evidence = results.flatMap((surface) => surface.evidence);
    const failedEvidence = evidence.filter((item) => item.outcome === "failed").length;
    const unavailableEvidence = evidence.filter((item) => item.outcome === "unavailable").length;
    const errorEvidence = evidence.filter((item) => item.outcome === "error").length;
    const evidenceIssues = failedEvidence + unavailableEvidence + errorEvidence;
    const unsupportedAnalyzers = [
      ...(results.some((surface) => surface.kind === "rust-crate") ? ["rust-item-api"] : []),
      ...(results.some((surface) => surface.kind === "dotnet-assembly") ? ["dotnet-item-api"] : []),
      ...(results.some((surface) => surface.kind === "github-action") ? ["github-action-io"] : []),
      ...(results.some((surface) => surface.kind === "reusable-workflow")
        ? ["workflow-call-io"]
        : []),
      ...(results.some((surface) => surface.kind === "cli-command") ? ["cli-subcommands"] : []),
    ];
    const report: PublicContractReport = {
      schemaVersion: 1,
      revision: revision(root),
      enforcement,
      manifestPath,
      summary: {
        discovered: results.length,
        verified,
        unverified,
        incompleteDiscovery,
        failedEvidence,
        unavailableEvidence,
        errorEvidence,
        verifiedRatio: results.length === 0 ? null : verified / results.length,
        strictReady:
          results.length > 0 &&
          unverified === 0 &&
          incompleteDiscovery === 0 &&
          evidenceIssues === 0,
      },
      surfaces: results,
      unsupportedAnalyzers,
    };

    const diagnostics: Diagnostic[] = [];
    if (results.length === 0) {
      diagnostics.push({
        code: "public-contract-no-discovered-surfaces",
        message:
          "No public surfaces were discovered. Verification ratio is unavailable and strict readiness is false until absence can be established positively.",
      });
    }
    if (enforcement === "protect-new") {
      diagnostics.push({
        code: "public-contract-protect-new-not-yet-supported",
        message:
          "protect-new requires base-versus-head contract comparison and is not implemented in schemaVersion 1 yet.",
      });
      return reportEnvelope("unavailable", started, report, diagnostics);
    }
    if (enforcement === "strict" && !report.summary.strictReady) {
      diagnostics.push({
        code: "public-contract-not-strict-ready",
        message: `${report.summary.unverified} public surfaces are unverified, ${report.summary.incompleteDiscovery} have incomplete discovery, and ${evidenceIssues} evidence checks did not pass.`,
      });
      return reportEnvelope("failed", started, report, diagnostics);
    }
    return reportEnvelope("passed", started, report, diagnostics);
  } catch (error) {
    const report: PublicContractReport = {
      schemaVersion: 1,
      revision: revision(root),
      enforcement: "observe",
      manifestPath: ".coding-tooling.contracts.json",
      summary: {
        discovered: 0,
        verified: 0,
        unverified: 0,
        incompleteDiscovery: 0,
        failedEvidence: 0,
        unavailableEvidence: 0,
        errorEvidence: 0,
        verifiedRatio: null,
        strictReady: false,
      },
      surfaces: [],
      unsupportedAnalyzers: [],
    };
    return reportEnvelope("error", started, report, [
      {
        code: "invalid-public-contract",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
