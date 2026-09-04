#!/usr/bin/env bun

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeRepository } from "./analysis.ts";
import { calibrationCommand, type CalibrationEnvelope } from "./calibration.ts";
import { main } from "./cli.ts";
import { writeReport } from "./core.ts";
import {
  baselineFindings,
  findingCommand,
  findingsCommand,
  scaffoldFinding,
  type ExpectationEnvelope,
  type FindingState,
} from "./expectations.ts";
import type { ResultStatus } from "./model.ts";
import { publicContractCommand } from "./public-contract.ts";
import { fleetAudit, repositoryMetadataCommand } from "./repository-metadata.ts";
import { repositoryProgressScoreCommand } from "./repository-progress-score.ts";
import { repositoryRoot } from "./shared.ts";

function resultExitCode(status: ResultStatus): number {
  return status === "passed" ? 0 : status === "failed" ? 1 : status === "unavailable" ? 2 : 3;
}

function expectationExitCode(
  status: ExpectationEnvelope["status"] | CalibrationEnvelope["status"],
): number {
  return resultExitCode(status);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function expectationUsage(): never {
  console.error(`Usage:
  coding-tooling analyze [--json]
  coding-tooling score [--validation-report <path>] [--json]
  coding-tooling findings [--new|--baseline] [--all] [--json]
  coding-tooling finding <finding-id> [--json]
  coding-tooling baseline [--json]
  coding-tooling scaffold <finding-id> [--json]
  coding-tooling calibration [--json]
  coding-tooling repository metadata [--root <path>] [--json]
  coding-tooling fleet audit [--root <path>] [--json]
  coding-tooling contract <discover|verify> [--config <path>] [--report <path>] [--json]`);
  process.exit(2);
}

export function entryMain(argv = process.argv.slice(2)): number {
  const command = argv[0];
  if (command === "contract") {
    const action = argv[1] ?? "verify";
    if (action !== "discover" && action !== "verify") return expectationUsage();
    const knownFlags = new Set(["--json", "--config", "--report"]);
    for (let index = 2; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (!value.startsWith("--")) continue;
      if (!knownFlags.has(value)) return expectationUsage();
      if ((value === "--config" || value === "--report") && !argv[index + 1])
        return expectationUsage();
      if (value === "--config" || value === "--report") index += 1;
    }
    const root = repositoryRoot();
    const result = publicContractCommand(root, {
      configPath: option(argv, "config"),
      execute: action === "verify",
    });
    const report = option(argv, "report");
    if (report) writeReport(result, resolve(root, report));
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }

  if (command === "analyze") {
    if (argv.slice(1).some((value) => value !== "--json")) return expectationUsage();
    const result = analyzeRepository(repositoryRoot());
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }

  if (command === "score") {
    const knownFlags = new Set(["--json", "--validation-report"]);
    for (let index = 1; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (!value.startsWith("--") || !knownFlags.has(value)) return expectationUsage();
      if (value === "--validation-report") {
        if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) return expectationUsage();
        index += 1;
      }
    }
    const result = repositoryProgressScoreCommand(repositoryRoot(), {
      validationReportPath: option(argv, "validation-report"),
    });
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }

  if (command === "repository") {
    if (argv[1] !== "metadata") return expectationUsage();
    const knownFlags = new Set(["--json", "--root"]);
    for (let index = 2; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (!value.startsWith("--") || !knownFlags.has(value)) return expectationUsage();
      if (value === "--root") {
        if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) return expectationUsage();
        index += 1;
      }
    }
    const targetRoot = resolve(option(argv, "root") ?? repositoryRoot());
    const result = repositoryMetadataCommand(targetRoot);
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }

  if (command === "fleet") {
    if (argv[1] !== "audit") return expectationUsage();
    const knownFlags = new Set(["--json", "--root"]);
    for (let index = 2; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (!value.startsWith("--") || !knownFlags.has(value)) return expectationUsage();
      if (value === "--root") {
        if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) return expectationUsage();
        index += 1;
      }
    }
    const targetRoot = resolve(option(argv, "root") ?? resolve(repositoryRoot(), ".."));
    const result = fleetAudit(targetRoot);
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }

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
