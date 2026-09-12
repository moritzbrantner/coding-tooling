import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Capability } from "./model.ts";
import { readJson } from "./shared.ts";

export type NativeTestRunner = "bun" | "vitest";
export type TestExecutionEvidenceStatus = "available" | "unsupported" | "incomplete";

export type TestExecutionEvidence = {
  schemaVersion: 1;
  status: TestExecutionEvidenceStatus;
  runner: NativeTestRunner | null;
  script: string | null;
  executedCases: number | null;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  todoCases: number | null;
  reason: string;
};

type PackageManifest = {
  scripts?: Record<string, string>;
};

type RunnerResolution = {
  runner: NativeTestRunner | null;
  script: string | null;
  reason: string;
};

export type TestExecutionInput = {
  cwd: string;
  capability: Capability;
  command: string[];
  stdout: string;
  stderr: string;
};

function testCapability(capability: Capability): boolean {
  return capability === "test" || capability.startsWith("test:");
}

function packageScriptName(command: readonly string[]): string | undefined {
  if (command.length < 3) return undefined;
  if ((command[0] === "bun" || command[0] === "npm") && command[1] === "run") return command[2];
  return undefined;
}

function directRunner(command: string): NativeTestRunner | undefined {
  const value = command.trim();
  if (/^bun\s+test(?:\s|$)/.test(value)) return "bun";
  if (/^(?:bunx\s+|npx\s+)?vitest(?:\s+run)?(?:\s|$)/.test(value)) return "vitest";
  return undefined;
}

function wrapperScript(command: string): string | undefined {
  const match = /^(?:bun|npm)\s+run\s+([A-Za-z0-9:_-]+)(?:\s+--(?:\s+.*)?)?$/.exec(command.trim());
  return match?.[1];
}

function resolveScriptRunner(
  scripts: Record<string, string>,
  script: string,
  seen = new Set<string>(),
): RunnerResolution {
  if (seen.has(script)) return { runner: null, script, reason: "package-script-cycle" };
  const command = scripts[script];
  if (typeof command !== "string" || !command.trim()) {
    return { runner: null, script, reason: "package-script-missing" };
  }

  const runner = directRunner(command);
  if (runner) return { runner, script, reason: "native-runner-resolved" };

  const wrapped = wrapperScript(command);
  if (!wrapped) return { runner: null, script, reason: "package-script-runner-unrecognized" };
  const nextSeen = new Set(seen);
  nextSeen.add(script);
  return resolveScriptRunner(scripts, wrapped, nextSeen);
}

function resolveRunner(cwd: string, command: readonly string[]): RunnerResolution {
  if (command[0] === "bun" && command[1] === "test") {
    return { runner: "bun", script: null, reason: "native-command" };
  }
  if (
    (command[0] === "vitest" || command[0] === "bunx" || command[0] === "npx") &&
    (command[0] === "vitest" || command[1] === "vitest")
  ) {
    return { runner: "vitest", script: null, reason: "native-command" };
  }

  const script = packageScriptName(command);
  if (!script) return { runner: null, script: null, reason: "test-command-runner-unrecognized" };
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) {
    return { runner: null, script, reason: "package-manifest-unavailable" };
  }
  const manifest = readJson<PackageManifest>(manifestPath);
  if (!manifest?.scripts) return { runner: null, script, reason: "package-scripts-unavailable" };
  return resolveScriptRunner(manifest.scripts, script);
}

function count(text: string, pattern: RegExp): number | null {
  let value: number | null = null;
  for (const match of text.matchAll(pattern)) value = Number.parseInt(match[1]!, 10);
  return value;
}

function evidence(
  runner: NativeTestRunner,
  script: string | null,
  values: {
    passed: number | null;
    failed: number | null;
    skipped: number | null;
    todo: number | null;
  },
  reason: string,
): TestExecutionEvidence {
  const hasExecutedCounts = values.passed !== null || values.failed !== null;
  return {
    schemaVersion: 1,
    status: hasExecutedCounts ? "available" : "incomplete",
    runner,
    script,
    executedCases: hasExecutedCounts ? (values.passed ?? 0) + (values.failed ?? 0) : null,
    passedCases: values.passed,
    failedCases: values.failed,
    skippedCases: values.skipped,
    todoCases: values.todo,
    reason,
  };
}

function bunEvidence(text: string, script: string | null): TestExecutionEvidence {
  if (/\b(?:no tests found|0 tests?)\b/i.test(text)) {
    return evidence(
      "bun",
      script,
      { passed: 0, failed: 0, skipped: count(text, /\b(\d+)\s+skip\b/g), todo: count(text, /\b(\d+)\s+todo\b/g) },
      "bun-summary",
    );
  }
  return evidence(
    "bun",
    script,
    {
      passed: count(text, /\b(\d+)\s+pass\b/g),
      failed: count(text, /\b(\d+)\s+fail\b/g),
      skipped: count(text, /\b(\d+)\s+skip\b/g),
      todo: count(text, /\b(\d+)\s+todo\b/g),
    },
    "bun-summary",
  );
}

function vitestEvidence(text: string, script: string | null): TestExecutionEvidence {
  if (/no test files found/i.test(text) || /Tests\s+no tests/i.test(text)) {
    return evidence(
      "vitest",
      script,
      { passed: 0, failed: 0, skipped: 0, todo: 0 },
      "vitest-summary",
    );
  }
  const testsLine = text
    .split(/\r?\n/)
    .filter((line) => /^\s*Tests\s+/i.test(line))
    .at(-1);
  if (!testsLine) {
    return evidence(
      "vitest",
      script,
      { passed: null, failed: null, skipped: null, todo: null },
      "vitest-summary-unavailable",
    );
  }
  return evidence(
    "vitest",
    script,
    {
      passed: count(testsLine, /\b(\d+)\s+passed\b/g),
      failed: count(testsLine, /\b(\d+)\s+failed\b/g),
      skipped: count(testsLine, /\b(\d+)\s+skipped\b/g),
      todo: count(testsLine, /\b(\d+)\s+todo\b/g),
    },
    "vitest-summary",
  );
}

export function collectTestExecutionEvidence(
  input: TestExecutionInput,
): TestExecutionEvidence | undefined {
  if (!testCapability(input.capability)) return undefined;
  const resolution = resolveRunner(input.cwd, input.command);
  if (!resolution.runner) {
    return {
      schemaVersion: 1,
      status: "unsupported",
      runner: null,
      script: resolution.script,
      executedCases: null,
      passedCases: null,
      failedCases: null,
      skippedCases: null,
      todoCases: null,
      reason: resolution.reason,
    };
  }

  const output = `${input.stdout}\n${input.stderr}`;
  return resolution.runner === "bun"
    ? bunEvidence(output, resolution.script)
    : vitestEvidence(output, resolution.script);
}
