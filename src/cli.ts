#!/usr/bin/env bun
import { affectedRepository } from "./affected/affected.ts";
import { runChecks } from "./check/check.ts";
import { doctorRepository } from "./doctor/doctor.ts";
import { inspectRepository } from "./inspect/inspect.ts";
import {
  printAffected,
  printChecks,
  printDoctor,
  printInspection,
  printJson,
} from "./result/format.ts";
import { capabilityOrder, type Capability } from "./types.ts";

const args = Bun.argv.slice(2);
const command = args[0];

function flag(name: string): boolean {
  return args.includes(name);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function cwd(): string {
  return option("--cwd") ?? process.cwd();
}

function help(): never {
  console.log(`coding-tooling 0.1.0

Usage:
  coding-tooling inspect [--json] [--cwd PATH]
  coding-tooling check [CAPABILITY] [--json] [--cwd PATH]
  coding-tooling affected [--base REF] [--json] [--cwd PATH]
  coding-tooling doctor [--json] [--cwd PATH]

Capabilities:
  ${capabilityOrder.join("\n  ")}
`);
  process.exit(0);
}

function parseCapability(value: string | undefined): Capability | undefined {
  if (!value || value.startsWith("--")) return undefined;
  if (!capabilityOrder.includes(value as Capability)) {
    console.error(`Unknown capability: ${value}`);
    process.exit(2);
  }
  return value as Capability;
}

switch (command) {
  case "inspect": {
    const result = inspectRepository(cwd());
    flag("--json") ? printJson(result) : printInspection(result);
    break;
  }
  case "check": {
    const capability = parseCapability(args[1]);
    const result = runChecks(cwd(), capability);
    flag("--json") ? printJson(result) : printChecks(result);
    if (result.length === 0) process.exit(2);
    if (result.some((item) => item.status === "failed")) process.exit(1);
    break;
  }
  case "affected": {
    const result = affectedRepository(cwd(), option("--base"));
    flag("--json") ? printJson(result) : printAffected(result);
    break;
  }
  case "doctor": {
    const result = doctorRepository(cwd());
    flag("--json") ? printJson(result) : printDoctor(result);
    if (result.status === "failed") process.exit(1);
    break;
  }
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(2);
}
