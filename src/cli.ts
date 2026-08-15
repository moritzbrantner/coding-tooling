#!/usr/bin/env bun
import {
  affected,
  doctor,
  envelope,
  inspectRepository,
  runCheck,
  type Envelope,
  type Status,
} from "./tooling.ts";

type Parsed = {
  operation: string;
  positional: string[];
  json: boolean;
  root?: string;
  component?: string;
  base?: string;
  changeManifest?: string;
};

export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {
    operation: args[0] || "",
    positional: [],
    json: false,
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    const keys: Record<
      string,
      keyof Pick<Parsed, "root" | "component" | "base" | "changeManifest">
    > = {
      "--root": "root",
      "--component": "component",
      "--base": "base",
      "--change-manifest": "changeManifest",
    };
    const key = keys[arg];
    if (key) {
      const value = args[++index];
      if (!value) throw new Error("Missing value for " + arg);
      parsed[key] = value;
    } else if (arg.startsWith("--")) {
      throw new Error("Unknown option: " + arg);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

export function execute(args: string[]): {
  result: Envelope<object>;
  json: boolean;
  exitCode: number;
} {
  const started = Date.now();
  try {
    const parsed = parseArgs(args);
    const inspection = inspectRepository(parsed.root || process.cwd());
    let result: Envelope<object>;
    if (parsed.operation === "inspect") {
      result = envelope("inspect", started, "passed", inspection);
    } else if (parsed.operation === "check") {
      const capability = parsed.positional[0];
      if (!capability || parsed.positional.length > 1) {
        throw new Error(
          "Usage: coding-tooling check <capability> [--component <name>] [--root <path>] [--json]",
        );
      }
      result = runCheck(inspection, capability, parsed.component);
    } else if (parsed.operation === "affected") {
      if (parsed.base && parsed.changeManifest) {
        throw new Error("--base and --change-manifest are mutually exclusive");
      }
      result = affected(inspection, {
        base: parsed.base,
        changeManifest: parsed.changeManifest,
      });
    } else if (parsed.operation === "doctor") {
      result = doctor(inspection);
    } else {
      throw new Error("Usage: coding-tooling <inspect|check|affected|doctor> [options]");
    }
    return {
      result,
      json: parsed.json,
      exitCode: exitCode(result.status),
    };
  } catch (error) {
    const result = envelope("cli", started, "error", {}, [
      {
        code: "invalid-usage",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
    return {
      result,
      json: args.includes("--json"),
      exitCode: 2,
    };
  }
}

function exitCode(status: Status): number {
  return status === "passed" ? 0 : status === "failed" ? 1 : status === "unavailable" ? 2 : 3;
}

function render(result: Envelope<object>): string {
  if (result.status === "passed") {
    return result.operation + ": passed";
  }
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    result.operation + ": " + result.status
  );
}

if (import.meta.main) {
  const execution = execute(process.argv.slice(2));
  process.stdout.write(
    execution.json ? JSON.stringify(execution.result) + "\n" : render(execution.result) + "\n",
  );
  process.exitCode = execution.exitCode;
}
