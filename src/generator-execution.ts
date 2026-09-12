import { convergenceRuleMode } from "./convergence-rule-policy.ts";
import { applyGeneratorPlan, type GeneratorApplyOptions } from "./generator-apply.ts";
import { generatorCommand, type GeneratorPlan } from "./generators.ts";
import {
  evaluateGeneratorPrerequisites,
  verifyGeneratorPostconditions,
  type CapabilityChecker,
} from "./generator-verification.ts";
import type { ResultEnvelope } from "./model.ts";

export type GeneratorExecutionOptions = GeneratorApplyOptions & {
  checkCapability?: CapabilityChecker;
};

export function executeGeneratorCommand(
  root: string,
  id: string,
  rawInputs: Record<string, string>,
  explicitTarget?: string,
  options: GeneratorExecutionOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const planned = generatorCommand(root, "plan", id, rawInputs, explicitTarget);
  if (planned.status !== "passed") return planned;

  const plan = planned.data.plan as GeneratorPlan;
  const rule = { id: `generator.${id}`, mode: convergenceRuleMode(root, `generator.${id}`) };
  if (rule.mode !== "apply") {
    return {
      schemaVersion: 1,
      operation: "generate",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: {
        result: "rule-withheld",
        rule,
        plan,
      },
      diagnostics: [
        {
          code: "convergence-rule-withheld",
          message: `${rule.id} is configured as ${rule.mode}; generation planning is available but mutation is withheld`,
        },
      ],
    };
  }

  const prerequisites = evaluateGeneratorPrerequisites(root, plan);
  if (prerequisites.status !== "passed") {
    return {
      schemaVersion: 1,
      operation: "generate",
      status: "failed",
      durationMs: Date.now() - started,
      data: {
        result: "prerequisite-failed",
        rule,
        plan,
        prerequisites,
      },
      diagnostics: prerequisites.diagnostics,
    };
  }

  const generation = applyGeneratorPlan(root, plan, { writeFile: options.writeFile });
  if (generation.result !== "generated" && generation.result !== "no-op") {
    return {
      schemaVersion: 1,
      operation: "generate",
      status: "failed",
      durationMs: Date.now() - started,
      data: {
        result: generation.result,
        rule,
        plan,
        prerequisites,
        generation,
      },
      diagnostics: generation.diagnostics,
    };
  }

  const postconditions = verifyGeneratorPostconditions(root, plan, options.checkCapability);
  const verified = postconditions.status === "passed";
  return {
    schemaVersion: 1,
    operation: "generate",
    status: verified ? "passed" : "failed",
    durationMs: Date.now() - started,
    data: {
      result: verified ? "generated-and-verified" : "generated-but-unverified",
      rule,
      plan,
      prerequisites,
      generation,
      postconditions,
    },
    diagnostics: postconditions.diagnostics,
  };
}
