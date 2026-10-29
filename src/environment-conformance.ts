import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { environmentScriptState } from "./environment-script.ts";

export type EnvironmentFinding = {
  code: string;
  status: "failed" | "unavailable";
  severity: "error" | "advisory";
  message: string;
  path?: string;
};

export type EnvironmentToolchain = {
  tool: "bun" | "node" | "rust";
  path: string;
  declaredVersion: string | null;
  observedVersion: string | null;
  status: "passed" | "failed" | "unavailable";
};

export type CompatibilityHold = {
  tool: string;
  candidate: string;
  testedRevision: string;
  reason: string;
};

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function exactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/** Numeric prefix of a loose declaration such as `1.4.3`, `^1.4`, `>=24` or `v24.1`. */
function minimumVersion(value: string): number[] | null {
  const match = value.match(/^(?:[~^]|>=|v)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [match[1], match[2], match[3]].filter((part) => part !== undefined).map(Number);
}

/** True when an observed x.y.z release is older than the declared minimum. */
function olderThanDeclared(observed: string, declared: string): boolean {
  const minimum = minimumVersion(declared);
  const actual = minimumVersion(observed);
  if (!minimum || !actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    if (left !== minimum[index]) return left < minimum[index];
  }
  return false;
}

function commandVersion(
  command: string,
  args: string[],
  cwd: string,
  parse: (stdout: string) => string | null,
): string | null {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return parse(result.stdout.trim());
}

function bunDeclarations(root: string): {
  packageManagerVersion: string | null;
  versionFileVersion: string | null;
} {
  const packagePath = join(root, "package.json");
  let packageManagerVersion: string | null = null;
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(text(packagePath)) as { packageManager?: unknown };
    if (
      typeof packageJson.packageManager === "string" &&
      packageJson.packageManager.startsWith("bun@")
    ) {
      packageManagerVersion = packageJson.packageManager.slice("bun@".length);
    }
  }
  const versionPath = join(root, ".bun-version");
  return {
    packageManagerVersion,
    versionFileVersion: existsSync(versionPath) ? text(versionPath).trim() : null,
  };
}

// Every toolchain tracks the latest stable release (owner decision 2026-10-23). A declaration
// is a minimum, not a pin: any installed release satisfies it, and only an installed release
// older than the declared minimum yields an advisory diagnostic.
function toolchain(
  tool: EnvironmentToolchain["tool"],
  path: string,
  declaredVersion: string | null,
  observedVersion: string | null,
): EnvironmentToolchain {
  return {
    tool,
    path,
    declaredVersion,
    observedVersion,
    status: observedVersion === null ? "unavailable" : "passed",
  };
}

function bunToolchain(root: string): EnvironmentToolchain | null {
  const { packageManagerVersion, versionFileVersion } = bunDeclarations(root);
  const declaredVersion = packageManagerVersion ?? versionFileVersion;
  if (declaredVersion === null) return null;
  const observedVersion = commandVersion("bun", ["--version"], root, (value) => value || null);
  return toolchain(
    "bun",
    packageManagerVersion !== null ? "package.json" : ".bun-version",
    declaredVersion,
    observedVersion,
  );
}

function nodeToolchain(root: string): EnvironmentToolchain | null {
  const path = join(root, ".node-version");
  if (!existsSync(path)) return null;
  const observedVersion = commandVersion("node", ["--version"], root, (value) => {
    const version = value.match(/^v?(\d+\.\d+\.\d+)$/)?.[1];
    return version ?? null;
  });
  return toolchain("node", ".node-version", text(path).trim() || null, observedVersion);
}

function rustToolchain(root: string): EnvironmentToolchain | null {
  const path = join(root, "rust-toolchain.toml");
  if (!existsSync(path)) return null;
  const declaredVersion = text(path).match(/channel\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const observedVersion = commandVersion("rustc", ["--version"], root, (value) => {
    const version = value.match(/^rustc\s+(\d+\.\d+\.\d+)/)?.[1];
    return version ?? null;
  });
  return toolchain("rust", "rust-toolchain.toml", declaredVersion, observedVersion);
}

function unescapeTomlString(value: string): string {
  return value.replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function holdField(lines: string[], name: string): string | null {
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*$`));
    if (match) return unescapeTomlString(match[1]);
  }
  return null;
}

function compatibilityHolds(source: string): {
  holds: CompatibilityHold[];
  invalidTools: string[];
} {
  const lines = source.split(/\r?\n/);
  const holds: CompatibilityHold[] = [];
  const invalidTools: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\s*\[compatibility_holds\.([a-z0-9_-]+)\]\s*$/);
    if (!header) continue;
    const tool = header[1];
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    index -= 1;

    const candidate = holdField(body, "candidate");
    const testedRevision = holdField(body, "tested_revision");
    const reason = holdField(body, "reason");
    if (
      !candidate ||
      !exactVersion(candidate) ||
      !testedRevision ||
      !/^[0-9a-f]{40}$/i.test(testedRevision) ||
      !reason
    ) {
      invalidTools.push(tool);
      continue;
    }
    holds.push({ tool, candidate, testedRevision, reason });
  }

  return {
    holds: holds.sort((left, right) => left.tool.localeCompare(right.tool)),
    invalidTools: invalidTools.sort(),
  };
}

export function repositoryEnvironmentConformance(root: string): {
  data: Record<string, unknown>;
  findings: EnvironmentFinding[];
} {
  const findings: EnvironmentFinding[] = [];
  const configPath = join(root, ".repository-environment.toml");
  const scriptPath = join(root, "scripts", "codex-environment.sh");
  const configPresent = existsSync(configPath);
  const scriptPresent = existsSync(scriptPath);
  let holds: CompatibilityHold[] = [];

  if (!configPresent && !scriptPresent) {
    findings.push({
      code: "environment-v1-not-adopted",
      status: "unavailable",
      severity: "advisory",
      message: "environment-v1 has not been adopted",
    });
  } else {
    if (!configPresent) {
      findings.push({
        code: "environment-config-missing",
        status: "failed",
        severity: "error",
        message: ".repository-environment.toml is missing from a partial environment-v1 adoption",
        path: ".repository-environment.toml",
      });
    }
    if (!scriptPresent) {
      findings.push({
        code: "environment-script-missing",
        status: "failed",
        severity: "error",
        message: "scripts/codex-environment.sh is missing from a partial environment-v1 adoption",
        path: "scripts/codex-environment.sh",
      });
    }
  }

  if (configPresent) {
    const source = text(configPath);
    if (!/^schema_version\s*=\s*1\s*$/m.test(source)) {
      findings.push({
        code: "environment-config-invalid",
        status: "failed",
        severity: "error",
        message: ".repository-environment.toml must declare schema_version = 1",
        path: ".repository-environment.toml",
      });
    }
    if (!/^track\s*=\s*"latest-stable"\s*$/m.test(source)) {
      findings.push({
        code: "environment-track-invalid",
        status: "failed",
        severity: "error",
        message: 'environment-v1 policy must track "latest-stable"',
        path: ".repository-environment.toml",
      });
    }
    const parsed = compatibilityHolds(source);
    holds = parsed.holds;
    for (const tool of parsed.invalidTools) {
      findings.push({
        code: "environment-compatibility-hold-invalid",
        status: "failed",
        severity: "error",
        message: `compatibility hold for ${tool} is incomplete or invalid`,
        path: ".repository-environment.toml",
      });
    }
    for (const hold of holds) {
      findings.push({
        code: "environment-compatibility-hold",
        status: "unavailable",
        severity: "advisory",
        message: `${hold.tool} ${hold.candidate} is intentionally held: ${hold.reason}`,
        path: ".repository-environment.toml",
      });
    }
  }

  const scriptCurrent = scriptPresent && environmentScriptState(root) === "current";
  if (scriptPresent && !scriptCurrent) {
    findings.push({
      code: "environment-script-drift",
      status: "failed",
      severity: "error",
      message:
        "scripts/codex-environment.sh differs from the canonical coding-tooling script; run `coding-tooling environment generate`",
      path: "scripts/codex-environment.sh",
    });
  }

  const { packageManagerVersion, versionFileVersion } = bunDeclarations(root);
  if (
    packageManagerVersion !== null &&
    versionFileVersion !== null &&
    packageManagerVersion !== versionFileVersion
  ) {
    findings.push({
      code: "environment-bun-pin-conflict",
      status: "failed",
      severity: "error",
      message: `Bun pins conflict: package.json declares ${packageManagerVersion} but .bun-version declares ${versionFileVersion}`,
      path: ".bun-version",
    });
  }

  const toolchains = [bunToolchain(root), nodeToolchain(root), rustToolchain(root)]
    .filter((value): value is EnvironmentToolchain => value !== null)
    .sort((left, right) => left.tool.localeCompare(right.tool));

  for (const toolchain of toolchains) {
    const declared = toolchain.declaredVersion ?? "latest stable";
    if (toolchain.status === "unavailable") {
      findings.push({
        code: "environment-toolchain-unavailable",
        status: "unavailable",
        severity: "error",
        message: `${toolchain.tool} (${declared}) is declared but not available locally`,
        path: toolchain.path,
      });
    } else if (
      toolchain.observedVersion !== null &&
      toolchain.declaredVersion !== null &&
      olderThanDeclared(toolchain.observedVersion, toolchain.declaredVersion)
    ) {
      findings.push({
        code: "environment-toolchain-behind",
        status: "unavailable",
        severity: "advisory",
        message: `${toolchain.tool} ${toolchain.observedVersion} is older than the declared ${toolchain.declaredVersion}; environments track the latest stable release`,
        path: toolchain.path,
      });
    }
  }

  return {
    data: {
      adopted: configPresent && scriptPresent,
      configPath: ".repository-environment.toml",
      configPresent,
      scriptPath: "scripts/codex-environment.sh",
      scriptPresent,
      scriptCurrent,
      track: configPresent ? "latest-stable" : null,
      toolchains,
      compatibilityHolds: holds,
    },
    findings,
  };
}
