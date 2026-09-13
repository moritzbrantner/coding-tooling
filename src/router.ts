#!/usr/bin/env bun

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  agentHandoffCommand,
  agentVerificationCommand,
  taskPacketCommand,
} from "./agent-work.ts";
import { writeReport } from "./core.ts";
import { entryMain } from "./entry.ts";
import { fleetAuthorityGraph } from "./fleet-authority-graph.ts";
import type { ResultEnvelope } from "./model.ts";
import { nextSliceCommand } from "./next-slice.ts";
import { pullRequestIntegrationReceipt } from "./pr-integration-receipt.ts";
import { repositoryRoot } from "./shared.ts";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function exitCode(status: ResultEnvelope<Record<string, unknown>>["status"]): number {
  return status === "passed" ? 0 : status === "failed" ? 1 : status === "unavailable" ? 2 : 3;
}

function print(result: ResultEnvelope<Record<string, unknown>>, compact: boolean): number {
  console.log(JSON.stringify(result, null, compact ? 0 : 2));
  return exitCode(result.status);
}

function writeOptionalReport(
  root: string,
  argv: string[],
  result: ResultEnvelope<Record<string, unknown>>,
): void {
  const report = option(argv, "report");
  if (report) writeReport(result, resolve(root, report));
}

function usage(): number {
  console.error(`Additional agent-work commands:
  coding-tooling agent task-packet <path> [--root <path>] [--json]
  coding-tooling agent verify <path> [--root <path>] [--report <path>] [--json]
  coding-tooling agent handoff <path> --verification-report <path> [--root <path>] [--report <path>] [--json]
  coding-tooling next [--root <path>] [--json]
  coding-tooling pr receipt <number> [--expected-head <sha>] [--expected-base <sha>] [--root <path>] [--json]
  coding-tooling fleet authority-graph [--root <path>] [--json]`);
  return 2;
}

function validFlags(argv: string[], start: number, valueFlags: Set<string>): boolean {
  const allowed = new Set(["--json", ...valueFlags]);
  for (let index = start; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    if (!allowed.has(value)) return false;
    if (valueFlags.has(value)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) return false;
      index += 1;
    }
  }
  return true;
}

export function routerMain(argv = process.argv.slice(2)): number {
  const compact = argv.includes("--json");
  const root = resolve(option(argv, "root") ?? repositoryRoot());

  if (argv[0] === "agent") {
    const action = argv[1];
    const packetPath = argv[2];
    if (!packetPath || packetPath.startsWith("--")) return usage();
    if (action === "task-packet") {
      if (!validFlags(argv, 3, new Set(["--root"]))) return usage();
      return print(taskPacketCommand(root, packetPath), compact);
    }
    if (action === "verify") {
      if (!validFlags(argv, 3, new Set(["--root", "--report"]))) return usage();
      const result = agentVerificationCommand(root, packetPath);
      writeOptionalReport(root, argv, result);
      return print(result, compact);
    }
    if (action === "handoff") {
      if (
        !validFlags(argv, 3, new Set(["--root", "--report", "--verification-report"])) ||
        !option(argv, "verification-report")
      )
        return usage();
      const result = agentHandoffCommand(root, packetPath, option(argv, "verification-report")!);
      writeOptionalReport(root, argv, result);
      return print(result, compact);
    }
    return usage();
  }

  if (argv[0] === "next") {
    if (!validFlags(argv, 1, new Set(["--root"]))) return usage();
    return print(nextSliceCommand(root), compact);
  }

  if (argv[0] === "pr" && argv[1] === "receipt") {
    const prNumber = Number(argv[2]);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return usage();
    if (!validFlags(argv, 3, new Set(["--root", "--expected-head", "--expected-base"]))) {
      return usage();
    }
    return print(
      pullRequestIntegrationReceipt(root, prNumber, {
        expectedHeadSha: option(argv, "expected-head"),
        expectedBaseSha: option(argv, "expected-base"),
      }),
      compact,
    );
  }

  if (argv[0] === "fleet" && argv[1] === "authority-graph") {
    if (!validFlags(argv, 2, new Set(["--root"]))) return usage();
    return print(fleetAuthorityGraph(root), compact);
  }

  return entryMain(argv);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exitCode = routerMain();
