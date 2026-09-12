import {
  assertKnownConvergenceRuleIds,
  builtInRefactorRuleIds,
  convergenceRuleMode,
  refactorRuleId,
  type ConvergenceRuleMode,
} from "./convergence-rule-policy.ts";
import { applyGeneratorPlan, type GeneratorApplyOptions } from "./generator-apply.ts";
import { generatorCatalog, generatorCommand, type GeneratorPlan } from "./generators.ts";
import {
  evaluateGeneratorPrerequisites,
  verifyGeneratorPostconditions,
  type CapabilityChecker,
} from "./generator-verification.ts";
import type { ResultEnvelope } from "./model.ts";

export type GeneratorExecutionOptions = GeneratorApplyOptions & {
  checkCapability?: CapabilityChecker;
};

type AppliedConvergenceRule = {
  id: string;
  mode: ConvergenceRuleMode;
};

function executionRules(root: string, id: string, plan: GeneratorPlan): AppliedConvergenceRule[] {
  assertKnownConvergenceRuleIds(
    root,
    "generator",
    generatorCatalog(root).map((generator) => `generator.${generator.id}`),
  );
  assertKnownConvergenceRuleIds(root, "refactor", builtInRefactorRuleIds);

  const ids = new Set<string>([`generator.${id}`]);
  for (const operation of plan.operations) {
    ids.add(`generator.${operation.generator}`);
    const ruleId = refactorRuleId(operation.kind);
    if (ruleId) ids.add(ruleId);
  }
  return [...ids].sort().map((ruleId) => ({ id: ruleId, mode: convergenceRuleMode(root, ruleId) }));
}

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
  let rules: AppliedConvergenceRule[];
  try {
    rules = executionRules(root, id, plan);
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "generate",
      status: "error",
      durationMs: Date.now() - started,
      data: {
        result: "invalid-convergence-rule-policy",
        plan,
      },
      diagnostics: [
        {
          code: "invalid-convergence-rule-policy",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const withheldRules = rules.filter((rule) => rule.mode !== "apply");
  if (withheldRules.length > 0) {
    return {
      schemaVersion: 1,
      operation: "generate",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: {
        result: "rule-withheld",
        rules,
        withheldRules,
        plan,
      },
      diagnostics: [
        {
          code: "convergence-rule-withheld",
          message: `${withheldRules.map((rule) => `${rule.id}=${rule.mode}`).join(", ")} withholds mutation; deterministic generation planning remains available`,
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
        rules,
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
        rules,
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
      rules,
      plan,
      prerequisites,
      generation,
      postconditions,
    },
    diagnostics: postconditions.diagnostics,
  };
}
