import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";

export type EnvironmentFingerprintProfile = "default" | "source-development";

type FingerprintLayer = {
  digest: string;
  inputs: unknown;
};

type SourcePatch = {
  package: string;
  git: string;
  rev: string;
};

const lockfiles = [
  "Cargo.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
] as const;

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function exactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function fileDigest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function section(source: string, name: string): string | null {
  const lines = source.split(/\r?\n/);
  let active = false;
  const body: string[] = [];
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      if (active) break;
      active = header[1] === name;
      continue;
    }
    if (active) body.push(line);
  }
  return active || body.length > 0 ? body.join("\n") : null;
}

function stringField(source: string, name: string): string | null {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*$`, "m"));
  if (!match) return null;
  return JSON.parse(`"${match[1]}"`) as string;
}

function numberField(source: string, name: string): number | null {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, "m"));
  return match ? Number(match[1]) : null;
}

function stringArrayField(source: string, name: string): string[] {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) return [];
  const values = match[1].match(/"(?:\\.|[^"])*"/g) ?? [];
  return values.map((value) => JSON.parse(value) as string);
}

function toolchainInputs(root: string, diagnostics: Diagnostic[]): unknown {
  const toolchains: Record<string, unknown> = {};
  const packagePath = join(root, "package.json");
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(text(packagePath)) as { packageManager?: unknown };
    if (typeof packageJson.packageManager === "string" && packageJson.packageManager.startsWith("bun@")) {
      const version = packageJson.packageManager.slice("bun@".length);
      toolchains.bun = { version };
      if (!exactVersion(version)) {
        diagnostics.push({
          code: "environment-fingerprint-toolchain-floating",
          message: "Bun must use an exact x.y.z repository pin before it can be fingerprinted",
          path: "package.json",
        });
      }
    }
  }

  const rustPath = join(root, "rust-toolchain.toml");
  if (existsSync(rustPath)) {
    const source = text(rustPath);
    const toolchain = section(source, "toolchain") ?? source;
    const version = stringField(toolchain, "channel");
    const components = stringArrayField(toolchain, "components").sort();
    toolchains.rust = { version, components };
    if (!version || !exactVersion(version)) {
      diagnostics.push({
        code: "environment-fingerprint-toolchain-floating",
        message: "Rust must use an exact x.y.z repository pin before it can be fingerprinted",
        path: "rust-toolchain.toml",
      });
    }
  }

  return toolchains;
}

function environmentConfig(root: string, diagnostics: Diagnostic[]): {
  config: unknown;
  native: unknown;
} {
  const path = join(root, ".repository-environment.toml");
  if (!existsSync(path)) {
    return {
      config: { adopted: false, schemaVersion: null },
      native: { apt: [] },
    };
  }

  const source = text(path);
  const schemaVersion = numberField(source, "schema_version");
  if (schemaVersion !== 1) {
    diagnostics.push({
      code: "environment-fingerprint-config-invalid",
      message: ".repository-environment.toml must declare schema_version = 1",
      path: ".repository-environment.toml",
    });
  }
  const system = section(source, "system") ?? "";
  return {
    config: { adopted: true, schemaVersion },
    native: { apt: stringArrayField(system, "apt").sort() },
  };
}

function dependencyInputs(root: string): unknown {
  return lockfiles
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, digest: fileDigest(join(root, path)) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sourceInputs(
  root: string,
  profile: EnvironmentFingerprintProfile,
  diagnostics: Diagnostic[],
): unknown {
  if (profile === "default") return { profile, mode: "registry" };

  const path = join(root, ".coding-tooling.source-deps.json");
  if (!existsSync(path)) {
    diagnostics.push({
      code: "environment-fingerprint-source-config-missing",
      message: "source-development fingerprint requires .coding-tooling.source-deps.json",
      path: ".coding-tooling.source-deps.json",
    });
    return { profile, mode: "source-development", configPresent: false };
  }

  const parsed = JSON.parse(text(path)) as {
    schemaVersion?: unknown;
    cargo?: { localOnly?: unknown; patches?: unknown };
  };
  if (
    (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
    !parsed.cargo ||
    !Array.isArray(parsed.cargo.patches)
  ) {
    diagnostics.push({
      code: "environment-fingerprint-source-config-invalid",
      message: ".coding-tooling.source-deps.json is not a supported source dependency contract",
      path: ".coding-tooling.source-deps.json",
    });
    return { profile, mode: "source-development", configPresent: true };
  }

  const patches: SourcePatch[] = [];
  for (const candidate of parsed.cargo.patches) {
    if (!candidate || typeof candidate !== "object") continue;
    const patch = candidate as Record<string, unknown>;
    if (
      typeof patch.package !== "string" ||
      typeof patch.git !== "string" ||
      typeof patch.rev !== "string"
    ) {
      diagnostics.push({
        code: "environment-fingerprint-source-config-invalid",
        message: "Every source patch must declare package, git, and rev",
        path: ".coding-tooling.source-deps.json",
      });
      continue;
    }
    patches.push({ package: patch.package, git: patch.git, rev: patch.rev });
  }
  patches.sort((left, right) => left.package.localeCompare(right.package));

  return {
    profile,
    mode: "source-development",
    schemaVersion: parsed.schemaVersion,
    localOnly: parsed.cargo.localOnly === true,
    patches,
  };
}

export function expectedEnvironmentFingerprint(
  root: string,
  profile: EnvironmentFingerprintProfile = "default",
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  const diagnostics: Diagnostic[] = [];
  try {
    const environment = environmentConfig(root, diagnostics);
    const layerInputs = {
      toolchain: toolchainInputs(root, diagnostics),
      native: environment.native,
      dependencies: dependencyInputs(root),
      sources: sourceInputs(root, profile, diagnostics),
      config: environment.config,
    };
    const layers = Object.fromEntries(
      Object.entries(layerInputs).map(([name, inputs]) => [
        name,
        { inputs, digest: digest({ version: "environment-fingerprint-v1", layer: name, inputs }) },
      ]),
    ) as Record<string, FingerprintLayer>;
    const fingerprint = `env-v1:${digest({
      version: "environment-fingerprint-v1",
      profile,
      layers: Object.fromEntries(
        Object.entries(layers).map(([name, layer]) => [name, layer.digest]),
      ),
    })}`;

    return {
      schemaVersion: 1,
      operation: "environment",
      status: diagnostics.length === 0 ? "passed" : "failed",
      durationMs: Math.round(performance.now() - started),
      data: {
        action: "fingerprint",
        fingerprintVersion: "environment-fingerprint-v1",
        profile,
        fingerprint: diagnostics.length === 0 ? fingerprint : null,
        layers,
      },
      diagnostics,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "environment",
      status: "error",
      durationMs: Math.round(performance.now() - started),
      data: { action: "fingerprint", fingerprintVersion: "environment-fingerprint-v1", profile },
      diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
