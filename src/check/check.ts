import { join } from "node:path";
import { getProfile } from "../profiles/index.ts";
import { inspectRepository } from "../inspect/inspect.ts";
import { runCommand } from "../shared/command.ts";
import { capabilityOrder, type Capability, type CheckResult } from "../types.ts";

export interface CheckPlanItem {
  component: string;
  componentPath: string;
  capability: Capability;
  command: string[];
  cwd: string;
}

export function resolveCheckPlan(root: string, capability?: Capability): CheckPlanItem[] {
  const inspection = inspectRepository(root);
  const requested = capability ? [capability] : capabilityOrder;
  const plan: CheckPlanItem[] = [];

  for (const component of inspection.components) {
    const profile = getProfile(component.profile);
    for (const item of requested) {
      if (!component.capabilities.includes(item)) continue;
      const definition = profile.capabilities[item];
      if (!definition) continue;
      plan.push({
        component: component.name,
        componentPath: component.path,
        capability: item,
        command: definition.command,
        cwd: component.path === "." ? inspection.root : join(inspection.root, component.path),
      });
    }
  }

  return plan.sort(
    (a, b) =>
      capabilityOrder.indexOf(a.capability) - capabilityOrder.indexOf(b.capability) ||
      a.component.localeCompare(b.component),
  );
}

export function runChecks(root: string, capability?: Capability): CheckResult[] {
  const plan = resolveCheckPlan(root, capability);
  return plan.map((item) => {
    const execution = runCommand(item.command, item.cwd);
    return {
      schemaVersion: 1,
      capability: item.capability,
      status: execution.exitCode === 0 ? "passed" : "failed",
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      component: item.component,
      componentPath: item.componentPath,
      command: item.command,
      stdout: execution.stdout,
      stderr: execution.stderr,
    };
  });
}
