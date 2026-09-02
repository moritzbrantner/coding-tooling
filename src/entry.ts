#!/usr/bin/env bun

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { calibrationCommand, type CalibrationEnvelope } from "./calibration.ts";
import { main } from "./cli.ts";
import {
  baselineFindings,
  findingCommand,
  findingsCommand,
  scaffoldFinding,
  type ExpectationEnvelope,
  type FindingState,
} from "./expectations.ts";
import { repositoryRoot } from "./shared.ts";

function expectationExitCode(
  status: ExpectationEnvelope["status"] | CalibrationEnvelope["status"],
): number {
  return status === "passed" ? 0 : status === "failed" ? 1 : status === "unavailable" ? 2 : 3;
}

function expectationUsage(): never {
  console.error(`Usage:
  coding-tooling findings [--new|--baseline] [--all] [--json]
  coding-tooling finding <finding-id> [--json]
  coding-tooling baseline [--json]
  coding-tooling scaffold <finding-id> [--json]
  coding-tooling calibration [--json]`);
  process.exit(2);
}

export function entryMain(argv = process.argv.slice(2)): number {
  const command = argv[0];
  if (
    command !== "findings" &&
    command !== "finding" &&
    command !== "baseline" &&
    command !== "scaffold" &&
    command !== "calibration"
  ) {
    return main(argv);
  }

  const root = repositoryRoot();
  const compact = argv.includes("--json");
  let result: ExpectationEnvelope | CalibrationEnvelope;
  if (command === "calibration") {
    if (argv.slice(1).some((value) => value !== "--json")) return expectationUsage();
    result = calibrationCommand(root);
  } else if (command === "findings") {
    const onlyNew = argv.includes("--new");
    const onlyBaseline = argv.includes("--baseline");
    const includeSuppressed = argv.includes("--all");
    const unknown = argv
      .slice(1)
      .filter((value) => !["--new", "--baseline", "--all", "--json"].includes(value));
    if (unknown.length > 0 || (onlyNew && onlyBaseline)) return expectationUsage();
    const state: FindingState | undefined = onlyNew ? "new" : onlyBaseline ? "baseline" : undefined;
    result = findingsCommand(root, { state, includeSuppressed });
  } else if (command === "finding") {
    const id = argv[1];
    if (!id || argv.slice(2).some((value) => value !== "--json")) return expectationUsage();
    result = findingCommand(root, id);
  } else if (command === "baseline") {
    if (argv.slice(1).some((value) => value !== "--json")) return expectationUsage();
    result = baselineFindings(root);
  } else {
    const id = argv[1];
    if (!id || argv.slice(2).some((value) => value !== "--json")) return expectationUsage();
    result = scaffoldFinding(root, id);
  }

  console.log(JSON.stringify(result, null, compact ? 0 : 2));
  return expectationExitCode(result.status);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exitCode = entryMain();
