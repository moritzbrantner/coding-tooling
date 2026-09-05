import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { discoverComponents, planChecks } from "./core.ts";
import type { Diagnostic, ResultEnvelope, ResultOperation, ResultStatus } from "./model.ts";
import { relativePosix, repositoryRoot, runCommand } from "./shared.ts";

type InstallManager = "bun" | "npm";

type InstallOwner = {
  path: string;
  manager: InstallManager;
  lockfile: string;
  command: string[];
};

export type DependencyInstallStep = InstallOwner & {
  components: string[];
};

type InstallPlanOptions = {
  root?: string;
  tier: string;
  component?: string;
  configPath?: string;
};

type InstallResult = DependencyInstallStep & {
  status: "passed" | "failed" | "error";
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

function installOwnerAt(root: string, directory: string): InstallOwner | undefined {
  const bunLock = existsSync(join(directory, "bun.lock"));
  const bunBinaryLock = existsSync(join(directory, "bun.lockb"));
  const npmLock = existsSync(join(directory, "package-lock.json"));
  if ((bunLock || bunBinaryLock) && npmLock) {
    throw new Error(
      `${relativePosix(root, directory)} contains both Bun and npm lockfiles; dependency installation is ambiguous`,
    );
  }
  if (bunLock || bunBinaryLock) {
    return {
      path: relativePosix(root, directory),
      manager: "bun",
      lockfile: bunLock ? "bun.lock" : "bun.lockb",
      command: ["bun", "install", "--frozen-lockfile"],
    };
  }
  if (npmLock) {
    return {
      path: relativePosix(root, directory),
      manager: "npm",
      lockfile: "package-lock.json",
      command: ["npm", "ci"],
    };
  }
  return undefined;
}

function envelope(
  operation: ResultOperation,
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function dependencyInstallPlan(
  options: InstallPlanOptions,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? repositoryRoot());
  try {
    const validationPlan = planChecks({
      root,
      tier: options.tier,
      component: options.component,
      configPath: options.configPath,
    });
    const plannedPaths = new Set(validationPlan.checks.map((check) => check.path));
    const selectedComponents = discoverComponents(root).filter(
      (component) =>
        plannedPaths.has(component.path) &&
        (!options.component ||
          component.name === options.component ||
          component.path === options.component),
    );

    const steps = new Map<string, DependencyInstallStep>();
    const diagnostics: Diagnostic[] = [];
    let conflict = false;
    for (const component of selectedComponents.filter((item) => item.kind === "package")) {
      let owner: InstallOwner | undefined;
      try {
        const directory = component.path === "." ? root : join(root, component.path);
        owner = installOwnerAt(root, directory);
      } catch (error) {
        conflict = true;
        diagnostics.push({
          code: "dependency-install-lockfile-conflict",
          message: error instanceof Error ? error.message : String(error),
          path: component.path,
        });
        continue;
      }
      if (!owner) {
        diagnostics.push({
          code: "dependency-install-lockfile-missing",
          message: `${component.name} is selected for execution but has no supported lockfile in its component directory; commit a lockfile or use caller-provided installation with install-mode: none`,
          path: component.path,
        });
        continue;
      }
      const existing = steps.get(owner.path);
      if (existing) {
        existing.components.push(component.name);
        continue;
      }
      steps.set(owner.path, { ...owner, components: [component.name] });
    }

    const ordered = [...steps.values()]
      .map((step) => ({ ...step, components: [...step.components].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const status: ResultStatus = conflict
      ? "failed"
      : diagnostics.length > 0
        ? "unavailable"
        : "passed";
    return envelope(
      "install",
      status,
      started,
      {
        action: "plan",
        planVersion: 1,
        root,
        profile: validationPlan.profile,
        tier: validationPlan.tier,
        component: options.component,
        selectedComponents: selectedComponents.map((component) => ({
          name: component.name,
          path: component.path,
          kind: component.kind,
        })),
        steps: ordered,
      },
      diagnostics,
    );
  } catch (error) {
    return envelope("install", "error", started, { action: "plan", planVersion: 1, root, tier: options.tier }, [
      {
        code: "dependency-install-plan-invalid",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

export function prepareDependencies(
  options: InstallPlanOptions,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? repositoryRoot());
  const plan = dependencyInstallPlan({ ...options, root });
  const steps = Array.isArray(plan.data.steps) ? (plan.data.steps as DependencyInstallStep[]) : [];
  if (plan.status !== "passed") {
    return envelope(
      "install",
      plan.status,
      started,
      { ...plan.data, action: "prepare", planStatus: plan.status, results: [] },
      plan.diagnostics,
    );
  }

  const results: InstallResult[] = [];
  for (const step of steps) {
    const cwd = step.path === "." ? root : join(root, step.path);
    const result = runCommand(step.command[0]!, step.command.slice(1), cwd);
    const status: InstallResult["status"] = result.error
      ? "error"
      : result.status === 0
        ? "passed"
        : "failed";
    results.push({
      ...step,
      status,
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    });
    if (status !== "passed") break;
  }

  const status: ResultStatus = results.some((result) => result.status === "error")
    ? "error"
    : results.some((result) => result.status === "failed")
      ? "failed"
      : "passed";
  return envelope(
    "install",
    status,
    started,
    { ...plan.data, action: "prepare", planStatus: plan.status, results },
    plan.diagnostics,
  );
}
