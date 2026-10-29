import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Diagnostic, ResultEnvelope } from "./model.ts";

/** Repository path of the generated environment-v1 entry point. */
export const environmentScriptPath = "scripts/codex-environment.sh";

const canonicalPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "codex-environment.sh",
);

/**
 * The single canonical environment-v1 script. Every repository commits an exact copy so setup
 * works offline; all repository-specific behaviour lives in `.repository-environment.toml`.
 */
export function canonicalEnvironmentScript(): string {
  return readFileSync(canonicalPath, "utf8");
}

export type EnvironmentScriptState = "current" | "drifted" | "missing";

export function environmentScriptState(root: string): EnvironmentScriptState {
  const path = join(root, environmentScriptPath);
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8") === canonicalEnvironmentScript() ? "current" : "drifted";
}

/**
 * `coding-tooling environment generate [--check]`: write the canonical script into the
 * repository, or with `check` only report whether the committed copy matches it.
 */
export function generateEnvironmentScript(
  root: string,
  options: { check?: boolean } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const before = environmentScriptState(root);
  const diagnostics: Diagnostic[] = [];
  let state = before;
  if (options.check) {
    if (before !== "current") {
      diagnostics.push({
        code: before === "missing" ? "environment-script-missing" : "environment-script-drift",
        message:
          before === "missing"
            ? `${environmentScriptPath} is missing; run \`coding-tooling environment generate\``
            : `${environmentScriptPath} differs from the canonical coding-tooling script; run \`coding-tooling environment generate\``,
        path: environmentScriptPath,
      });
    }
  } else if (before !== "current") {
    const path = join(root, environmentScriptPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalEnvironmentScript());
    chmodSync(path, 0o755);
    state = "current";
  }
  return {
    schemaVersion: 1,
    operation: "environment",
    status: state === "current" ? "passed" : "failed",
    durationMs: Date.now() - started,
    data: {
      path: environmentScriptPath,
      previous: before,
      state,
      written: !options.check && before !== "current",
    },
    diagnostics,
  };
}
