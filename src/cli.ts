#!/usr/bin/env bun

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { agentCapabilitiesCommand } from "./agent-capabilities.ts";
import { resolveConventions } from "./conventions.ts";
import { affected, check, doctor, inspect, planEnvelope, runPlan, writeReport } from "./core.ts";
import { auditDependencies } from "./dependency-audit.ts";
import { capabilities, type Capability, type ResultEnvelope } from "./model.ts";
import { repositoryRoot } from "./shared.ts";
import { sourceDependencies } from "./source-deps.ts";

type Options = Record<string, string | boolean>;

function parse(argv: string[]): { command?: string; positional: string[]; options: Options } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, positional, options };
}

function stringOption(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function exitCode(status: ResultEnvelope<Record<string, unknown>>["status"]): number {
  return status === "passed" ? 0 : status === "failed" ? 1 : status === "unavailable" ? 2 : 3;
}

function usage(): never {
  console.error(`Usage:
  coding-tooling inspect [--json]
  coding-tooling check <capability> [--component <name>] [--json]
  coding-tooling affected [--base <git-ref>] [--json]
  coding-tooling doctor [--json]
  coding-tooling plan --tier <name> [--component <name>] [--config <path>] [--json]
  coding-tooling run --tier <name> [--component <name>] [--config <path>] [--report <path>] [--strict] [--json]
  coding-tooling source-deps <activate|status|deactivate> [--config <path>] [--json]
  coding-tooling dependencies audit [--config <path>] [--strict] [--json]
  coding-tooling agent-capabilities <validate|catalog|profile> [profile-name] [--root <path>] [--json]
  coding-tooling conventions resolve [--root <path>] [--config <path>] [--conventions-root <path>] [--registry <path>] [--json]`);
  process.exit(2);
}

export function main(argv = process.argv.slice(2)): number {
  const { command, positional, options } = parse(argv);
  const root = repositoryRoot();
  let result: ResultEnvelope<Record<string, unknown>>;
  if (command === "inspect") result = inspect(root);
  else if (command === "doctor") result = doctor(root);
  else if (command === "affected") result = affected(root, stringOption(options, "base") ?? "HEAD");
  else if (command === "check") {
    const capability = positional[0] as Capability | undefined;
    if (!capability || !capabilities.includes(capability)) return usage();
    result = check(root, capability, stringOption(options, "component"));
  } else if (command === "plan" || command === "run") {
    const tier = stringOption(options, "tier");
    if (!tier) return usage();
    const common = {
      root,
      tier,
      component: stringOption(options, "component"),
      configPath: stringOption(options, "config"),
    };
    result =
      command === "plan"
        ? planEnvelope(root, tier, common.component, common.configPath)
        : runPlan({ ...common, strict: Boolean(options.strict) });
    const report = stringOption(options, "report");
    if (report) writeReport(result, resolve(root, report));
  } else if (command === "source-deps") {
    const action = positional[0];
    if (action !== "activate" && action !== "status" && action !== "deactivate") return usage();
    result = sourceDependencies(root, action, stringOption(options, "config"));
  } else if (command === "dependencies") {
    if (positional[0] !== "audit") return usage();
    result = auditDependencies(root, stringOption(options, "config"), Boolean(options.strict));
  } else if (command === "agent-capabilities") {
    const action = positional[0];
    if (action !== "validate" && action !== "catalog" && action !== "profile") return usage();
    if (action === "profile" && !positional[1]) return usage();
    result = agentCapabilitiesCommand(
      resolve(stringOption(options, "root") ?? root),
      action,
      positional[1],
    );
  } else if (command === "conventions") {
    if (positional[0] !== "resolve") return usage();
    result = resolveConventions({
      root: resolve(stringOption(options, "root") ?? root),
      configPath: stringOption(options, "config"),
      conventionsRoot: stringOption(options, "conventions-root"),
      registryPath: stringOption(options, "registry"),
    });
  } else return usage();
  console.log(JSON.stringify(result, null, options.json ? 0 : 2));
  return exitCode(result.status);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exitCode = main();
