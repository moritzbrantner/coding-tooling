#!/usr/bin/env bun

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { agentCapabilitiesCommand } from "./agent-capabilities.ts";
import { conventionRegistryCommand } from "./convention-registry.ts";
import { resolveConventions } from "./conventions.ts";
import { affected, check, doctor, inspect, planEnvelope, runPlan, writeReport } from "./core.ts";
import { auditDependencies } from "./dependency-audit.ts";
import { capabilities, type Capability, type ResultEnvelope } from "./model.ts";
import {
  integratePullRequest,
  type MergeMethod,
  type RemoteChecksPolicy,
} from "./pr.ts";
import { repositoryRoot } from "./shared.ts";
import { sourceDependencies } from "./source-deps.ts";

type Options = Record<string, string | boolean>;

type PlannedCheckView = {
  capability?: unknown;
  component?: unknown;
};

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

function reportPullRequestIntegrationStart(
  root: string,
  prNumber: number,
  tier: string,
  remoteChecks: RemoteChecksPolicy,
  dryRun: boolean,
): void {
  console.error(`PR #${prNumber} integration${dryRun ? " dry run" : ""} started.`);
  console.error("  Checking the worktree, fetching the exact PR head and target branch, then testing a synthetic merge.");
  const plan = planEnvelope(root, tier);
  const checks = Array.isArray(plan.data.checks)
    ? (plan.data.checks as PlannedCheckView[])
    : [];
  if (checks.length > 0) {
    console.error(`  Local ${tier} pipeline: ${checks.length} planned check${checks.length === 1 ? "" : "s"}:`);
    for (const check of checks) {
      const component = typeof check.component === "string" ? check.component : "repository";
      const capability = typeof check.capability === "string" ? check.capability : "unknown";
      console.error(`    - ${component}: ${capability}`);
    }
  } else {
    console.error(`  Local ${tier} pipeline plan could not enumerate checks before execution.`);
  }
  console.error(
    `  Hosted GitHub checks: ${remoteChecks === "advisory" ? "advisory" : "required"}.`,
  );
  console.error("  Local validation can take several minutes. Final JSON is printed when the operation finishes.");
}

function reportPullRequestIntegrationResult(
  prNumber: number,
  result: ResultEnvelope<Record<string, unknown>>,
  dryRun: boolean,
): void {
  const seconds = (result.durationMs / 1000).toFixed(1);
  console.error(`PR #${prNumber} integration finished: ${result.status} (${seconds}s).`);
  const pipeline = result.data.pipeline;
  if (pipeline && typeof pipeline === "object" && "status" in pipeline) {
    const status = (pipeline as { status?: unknown }).status;
    if (typeof status === "string") console.error(`  Local pipeline: ${status}.`);
  }
  if (result.status === "passed" && dryRun) console.error("  Dry run passed; no merge was attempted.");
  for (const diagnostic of result.diagnostics) {
    const label = diagnostic.code ? `${diagnostic.code}: ` : "";
    console.error(`  ${label}${diagnostic.message}`);
  }
}

function usage(): never {
  console.error(`Usage:
  coding-tooling inspect [--json]
  coding-tooling check <capability> [--component <name>] [--json]
  coding-tooling affected [--base <git-ref>] [--json]
  coding-tooling doctor [--json]
  coding-tooling plan --tier <name> [--component <name>] [--config <path>] [--json]
  coding-tooling run --tier <name> [--component <name>] [--config <path>] [--report <path>] [--strict] [--json]
  coding-tooling pr integrate <number> [--tier <name>] [--merge-method <squash|merge|rebase>] [--remote <name>] [--remote-checks <required|advisory>] [--dry-run] [--json]
  coding-tooling source-deps <activate|status|deactivate> [--config <path>] [--json]
  coding-tooling dependencies audit [--config <path>] [--strict] [--json]
  coding-tooling agent-capabilities <validate|catalog|profile> [profile-name] [--root <path>] [--json]
  coding-tooling conventions init [module...] [--profile <name>] [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
  coding-tooling conventions add <module...> [--profile <name>] [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
  coding-tooling conventions check [--root <path>] [--json]
  coding-tooling conventions diff [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
  coding-tooling conventions update [--root <path>] [--conventions-root <path>] [--registry <path>] [--json]
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
  } else if (command === "pr") {
    const action = positional[0];
    const prNumber = Number(positional[1]);
    const mergeMethodOption = stringOption(options, "merge-method");
    const remoteChecksOption = stringOption(options, "remote-checks");
    if (
      action !== "integrate" ||
      !Number.isInteger(prNumber) ||
      prNumber <= 0 ||
      (mergeMethodOption && !["squash", "merge", "rebase"].includes(mergeMethodOption)) ||
      (remoteChecksOption && !["required", "advisory"].includes(remoteChecksOption))
    )
      return usage();
    const tier = stringOption(options, "tier") ?? "full";
    const remoteChecks = (remoteChecksOption ?? "advisory") as RemoteChecksPolicy;
    const dryRun = Boolean(options["dry-run"]);
    reportPullRequestIntegrationStart(root, prNumber, tier, remoteChecks, dryRun);
    result = integratePullRequest(root, prNumber, {
      tier,
      mergeMethod: mergeMethodOption as MergeMethod | undefined,
      remote: stringOption(options, "remote"),
      remoteChecks,
      dryRun,
    });
    reportPullRequestIntegrationResult(prNumber, result, dryRun);
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
    const action = positional[0];
    const targetRoot = resolve(stringOption(options, "root") ?? root);
    if (action === "resolve") {
      result = resolveConventions({
        root: targetRoot,
        configPath: stringOption(options, "config"),
        conventionsRoot: stringOption(options, "conventions-root"),
        registryPath: stringOption(options, "registry"),
      });
    } else if (
      action === "init" ||
      action === "add" ||
      action === "check" ||
      action === "diff" ||
      action === "update"
    ) {
      if (action === "add" && positional.length < 2 && !stringOption(options, "profile"))
        return usage();
      result = conventionRegistryCommand(action, positional.slice(1), {
        root: targetRoot,
        conventionsRoot: stringOption(options, "conventions-root"),
        registryPath: stringOption(options, "registry"),
        profile: stringOption(options, "profile"),
      });
    } else return usage();
  } else return usage();
  console.log(JSON.stringify(result, null, options.json ? 0 : 2));
  return exitCode(result.status);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) process.exitCode = main();
