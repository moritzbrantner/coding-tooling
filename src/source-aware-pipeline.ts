import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { runPlan } from "./core.ts";
import { verifyEnvironmentFingerprint } from "./environment-verification.ts";
import { type Diagnostic, type ResultEnvelope, type ResultStatus } from "./model.ts";
import { sourceDependencies } from "./source-deps.ts";
import { walkFiles } from "./shared.ts";

type PipelineRunner = typeof runPlan;
type SourceDependenciesRunner = typeof sourceDependencies;
type EnvironmentVerifier = typeof verifyEnvironmentFingerprint;

type SourceDependencyConfig = {
  schemaVersion?: unknown;
  cargo?: {
    localOnly?: unknown;
    configPath?: unknown;
  };
};

type FileSnapshot = {
  path: string;
  existed: boolean;
  bytes?: Buffer;
  parentExisted: boolean;
};

export type SourceAwarePipelineDependencies = {
  runPipeline?: PipelineRunner;
  sourceDependencies?: SourceDependenciesRunner;
  verifyEnvironment?: EnvironmentVerifier;
};

export type SourceAwarePipelineExecution = {
  pipeline: ResultEnvelope<Record<string, unknown>>;
  sourceDevelopment: boolean;
  sourceActivation?: ResultEnvelope<Record<string, unknown>>;
  environment?: ResultEnvelope<Record<string, unknown>>;
};

function envelope(
  status: ResultStatus,
  phase: string,
  tier: string,
  diagnostics: Diagnostic[],
  data: Record<string, unknown> = {},
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "run",
    status,
    durationMs: 0,
    data: { tier, sourceDevelopment: true, phase, ...data },
    diagnostics,
  };
}

function sourceDevelopmentConfig(root: string): {
  enabled: boolean;
  cargoConfigPath?: string;
  diagnostic?: Diagnostic;
} {
  const configPath = join(root, ".coding-tooling.source-deps.json");
  if (!existsSync(configPath)) return { enabled: false };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as SourceDependencyConfig;
    if (parsed.cargo?.localOnly !== true) return { enabled: false };
    const cargoConfigPath =
      typeof parsed.cargo.configPath === "string" && parsed.cargo.configPath.trim()
        ? resolve(root, parsed.cargo.configPath)
        : join(root, ".cargo", "config.toml");
    return { enabled: true, cargoConfigPath };
  } catch (error) {
    return {
      enabled: true,
      diagnostic: {
        code: "source-development-config-invalid",
        message: error instanceof Error ? error.message : String(error),
        path: ".coding-tooling.source-deps.json",
      },
    };
  }
}

function snapshotFile(path: string): FileSnapshot {
  return {
    path,
    existed: existsSync(path),
    ...(existsSync(path) ? { bytes: readFileSync(path) } : {}),
    parentExisted: existsSync(dirname(path)),
  };
}

function cargoLockSnapshots(root: string): FileSnapshot[] {
  const paths = walkFiles(root, 12).filter((path) => basename(path) === "Cargo.lock");
  // oxlint-disable-next-line unicorn/no-array-sort -- paths is a fresh array and the repository lib target predates Array#toSorted.
  paths.sort();
  return paths.map(snapshotFile);
}

function restoreFile(snapshot: FileSnapshot): Diagnostic[] {
  try {
    if (snapshot.existed) {
      mkdirSync(dirname(snapshot.path), { recursive: true });
      writeFileSync(snapshot.path, snapshot.bytes ?? Buffer.alloc(0));
    } else {
      rmSync(snapshot.path, { force: true });
      if (!snapshot.parentExisted) {
        try {
          rmdirSync(dirname(snapshot.path));
        } catch {
          // The directory may contain other caller-owned state; leave it intact.
        }
      }
    }
    return [];
  } catch (error) {
    return [
      {
        code: "source-development-state-restore-failed",
        message: `Could not restore ${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

function restoreSourceState(
  root: string,
  cargoConfig: FileSnapshot,
  cargoLocks: FileSnapshot[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const knownLocks = new Set(cargoLocks.map((snapshot) => snapshot.path));
  for (const path of walkFiles(root, 12).filter(
    (candidate) => basename(candidate) === "Cargo.lock",
  )) {
    if (!knownLocks.has(path)) {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        diagnostics.push({
          code: "source-development-state-restore-failed",
          message: `Could not remove generated ${path}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  for (const snapshot of cargoLocks) diagnostics.push(...restoreFile(snapshot));
  diagnostics.push(...restoreFile(cargoConfig));
  return diagnostics;
}

function withRestoreDiagnostics(
  pipeline: ResultEnvelope<Record<string, unknown>>,
  diagnostics: Diagnostic[],
): ResultEnvelope<Record<string, unknown>> {
  if (diagnostics.length === 0) return pipeline;
  return {
    ...pipeline,
    status: "error",
    diagnostics: [...pipeline.diagnostics, ...diagnostics],
  };
}

export function runSourceAwarePipeline(
  root: string,
  tier: string,
  dependencies: SourceAwarePipelineDependencies = {},
): SourceAwarePipelineExecution {
  const pipelineRunner = dependencies.runPipeline ?? runPlan;
  const sourceDependenciesRunner = dependencies.sourceDependencies ?? sourceDependencies;
  const environmentVerifier = dependencies.verifyEnvironment ?? verifyEnvironmentFingerprint;
  const source = sourceDevelopmentConfig(root);

  if (!source.enabled) {
    return {
      pipeline: pipelineRunner({ root, tier, strict: false }),
      sourceDevelopment: false,
    };
  }
  if (source.diagnostic || !source.cargoConfigPath) {
    return {
      pipeline: envelope(
        "error",
        "source-config",
        tier,
        source.diagnostic ? [source.diagnostic] : [],
      ),
      sourceDevelopment: true,
    };
  }

  const cargoConfig = snapshotFile(source.cargoConfigPath);
  const cargoLocks = cargoLockSnapshots(root);
  const activation = sourceDependenciesRunner(root, "activate");
  if (activation.status !== "passed") {
    const cleanupDiagnostics = restoreSourceState(root, cargoConfig, cargoLocks);
    return {
      pipeline: withRestoreDiagnostics(
        envelope(activation.status, "source-activation", tier, activation.diagnostics, {
          activation: activation.data,
        }),
        cleanupDiagnostics,
      ),
      sourceDevelopment: true,
      sourceActivation: activation,
    };
  }

  const environment = environmentVerifier(root, "source-development");
  if (environment.status !== "passed") {
    const cleanupDiagnostics = restoreSourceState(root, cargoConfig, cargoLocks);
    return {
      pipeline: withRestoreDiagnostics(
        envelope(environment.status, "environment-verification", tier, environment.diagnostics, {
          expectedFingerprint: environment.data.expectedFingerprint ?? null,
          verifiedFingerprint: environment.data.verifiedFingerprint ?? null,
        }),
        cleanupDiagnostics,
      ),
      sourceDevelopment: true,
      sourceActivation: activation,
      environment,
    };
  }

  const pipeline = pipelineRunner({
    root,
    tier,
    strict: false,
    dependencyResolution: "source-development",
  });
  const cleanupDiagnostics = restoreSourceState(root, cargoConfig, cargoLocks);
  return {
    pipeline: withRestoreDiagnostics(pipeline, cleanupDiagnostics),
    sourceDevelopment: true,
    sourceActivation: activation,
    environment,
  };
}
