import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { runConventionChecks } from "./convention-enforcement.ts";
import { conventionRegistryCommand } from "./convention-registry.ts";
import { discoverComponents, loadConfig, planChecks } from "./core.ts";
import {
  defaultTiers,
  type Diagnostic,
  type ResultEnvelope,
  type ResultStatus,
  type ToolingConfig,
} from "./model.ts";
import { commandAvailable, readJson, repositoryRoot } from "./shared.ts";

type FindingStatus = "failed" | "unavailable";
type FindingSeverity = "error" | "advisory";

export type ConformanceFinding = {
  code: string;
  status: FindingStatus;
  severity: FindingSeverity;
  message: string;
  path?: string;
  conventionId?: string;
};

type ConsumerManifest = {
  schemaVersion?: unknown;
  registry?: unknown;
  modules?: unknown;
};

type ToolAvailability = {
  name: string;
  status: "passed" | "unavailable";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findingFromDiagnostic(
  diagnostic: Diagnostic,
  status: FindingStatus,
  conventionId?: string,
): ConformanceFinding {
  return {
    code: diagnostic.code ?? "conformance-diagnostic",
    status,
    severity: "error",
    message: diagnostic.message,
    path: diagnostic.path,
    conventionId,
  };
}

function sortFindings(findings: ConformanceFinding[]): ConformanceFinding[] {
  return findings.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.conventionId ?? "").localeCompare(right.conventionId ?? "") ||
      left.message.localeCompare(right.message),
  );
}

function reportStatus(findings: ConformanceFinding[]): ResultStatus {
  const blocking = findings.filter((finding) => finding.severity === "error");
  if (blocking.some((finding) => finding.status === "failed")) return "failed";
  if (blocking.some((finding) => finding.status === "unavailable")) return "unavailable";
  return "passed";
}

function selectedModules(root: string): string[] {
  const value = readJson<ConsumerManifest>(join(root, "conventions.json"));
  if (!Array.isArray(value?.modules)) return [];
  return value.modules.filter((module): module is string => typeof module === "string").sort();
}

export function conformanceReport(
  options: { root?: string; configPath?: string } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? repositoryRoot());
  const configPath = options.configPath ?? ".coding-tooling.json";
  const findings: ConformanceFinding[] = [];
  const components = discoverComponents(root);
  const technologies = [...new Set(components.flatMap((component) => component.technologies))].sort();

  if (components.length === 0) {
    findings.push({
      code: "repository-components-unavailable",
      status: "unavailable",
      severity: "error",
      message: "No supported repository components were discovered",
    });
  }

  const toolingConfigPresent = existsSync(join(root, configPath));
  let toolingConfig: ToolingConfig = { schemaVersion: 1 };
  let toolingConfigValid = true;
  if (!toolingConfigPresent) {
    findings.push({
      code: "tooling-config-missing",
      status: "failed",
      severity: "error",
      message: `${configPath} is missing`,
      path: configPath,
    });
  } else {
    try {
      toolingConfig = loadConfig(root, configPath);
    } catch (error) {
      toolingConfigValid = false;
      findings.push({
        code: "tooling-config-invalid",
        status: "failed",
        severity: "error",
        message: errorMessage(error),
        path: configPath,
      });
    }
  }

  const tierReports: Array<Record<string, unknown>> = [];
  const plannedCommands = new Set<string>();
  if (toolingConfigValid) {
    const tiers = [
      ...new Set([...Object.keys(defaultTiers), ...Object.keys(toolingConfig.tiers ?? {})]),
    ].sort();
    for (const tier of tiers) {
      try {
        const plan = planChecks({ root, tier, configPath });
        for (const check of plan.checks) plannedCommands.add(check.command[0]);
        for (const missing of plan.missing) {
          findings.push({
            code: missing.optional ? "optional-capability-unavailable" : "capability-unavailable",
            status: "unavailable",
            severity: missing.optional ? "advisory" : "error",
            message: `${missing.capability} is unavailable for ${missing.component}`,
          });
        }
        tierReports.push({
          name: tier,
          checks: plan.checks,
          missing: plan.missing,
          conventionRequiredCapabilities: plan.conventionRequiredCapabilities,
        });
      } catch (error) {
        findings.push({
          code: "tier-plan-invalid",
          status: "failed",
          severity: "error",
          message: `${tier}: ${errorMessage(error)}`,
          path: configPath,
        });
      }
    }
  }

  const tools: ToolAvailability[] = [...plannedCommands]
    .sort()
    .map((name) => ({ name, status: commandAvailable(name) ? "passed" : "unavailable" }));
  for (const tool of tools) {
    if (tool.status === "passed") continue;
    findings.push({
      code: "tool-unavailable",
      status: "unavailable",
      severity: "error",
      message: `${tool.name} is unavailable for a planned repository check`,
    });
  }

  const conventionManifestPresent = existsSync(join(root, "conventions.json"));
  const conventionLockPresent = existsSync(join(root, "conventions.lock.json"));
  const conventionCheck = conventionRegistryCommand("check", [], { root });
  if (conventionCheck.status !== "passed") {
    const status: FindingStatus =
      conventionCheck.status === "unavailable" ? "unavailable" : "failed";
    for (const diagnostic of conventionCheck.diagnostics) {
      findings.push(findingFromDiagnostic(diagnostic, status));
    }
  }

  let enforcementStatus: ResultStatus = "unavailable";
  let enforcementResults: Array<Record<string, unknown>> = [];
  if (conventionCheck.status === "passed") {
    const enforcement = runConventionChecks(root, components);
    enforcementStatus = enforcement.status;
    enforcementResults = enforcement.results.map((result) => ({
      ruleId: result.ruleId,
      kind: result.kind,
      component: result.component,
      status: result.status,
      command: result.command,
    }));
    for (const result of enforcement.results) {
      if (result.status === "passed") continue;
      findings.push({
        code:
          result.status === "unavailable"
            ? "convention-enforcement-unavailable"
            : "convention-enforcement-failed",
        status: result.status === "unavailable" ? "unavailable" : "failed",
        severity: "error",
        message: `${result.ruleId} ${result.status} for ${result.component}`,
        conventionId: result.ruleId,
      });
    }
  }

  const orderedFindings = sortFindings(findings);
  const status = reportStatus(orderedFindings);
  return {
    schemaVersion: 1,
    operation: "conformance",
    status,
    durationMs: Date.now() - started,
    data: {
      reportVersion: 1,
      root,
      repositoryName: basename(root),
      technologies,
      components,
      tooling: {
        configPath,
        configPresent: toolingConfigPresent,
        configValid: toolingConfigValid,
        profile: toolingConfigValid ? toolingConfig.profile : undefined,
        requiredCapabilities: toolingConfigValid
          ? [...(toolingConfig.requiredCapabilities ?? [])].sort()
          : [],
        optionalCapabilities: toolingConfigValid
          ? [...(toolingConfig.optionalCapabilities ?? [])].sort()
          : [],
        tiers: tierReports,
      },
      conventions: {
        manifestPresent: conventionManifestPresent,
        lockPresent: conventionLockPresent,
        selectedModules: selectedModules(root),
        snapshot: {
          status: conventionCheck.status,
          requestedModules: conventionCheck.data.requestedModules ?? [],
          resolvedModules: conventionCheck.data.resolvedModules ?? [],
          sourceRevision: conventionCheck.data.sourceRevision,
          drift: conventionCheck.data.drift ?? [],
        },
        enforcement: {
          status: enforcementStatus,
          results: enforcementResults,
        },
      },
      tools,
      findings: orderedFindings,
    },
    diagnostics: orderedFindings.map((finding) => ({
      code: finding.code,
      message: finding.message,
      path: finding.path,
    })),
  };
}
