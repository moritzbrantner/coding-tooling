import {
  convergenceRuleMode,
  normalizerRuleId,
  scaffoldRuleId,
  setConvergenceRuleMode,
  type ConvergenceRuleMode,
} from "./convergence-rule-policy.ts";
import { expectationRegistry, findingsCommand, type Finding } from "./expectations.ts";
import { generatorCatalog } from "./generators.ts";
import type { ResultEnvelope } from "./model.ts";
import { planNormalization } from "./normalization.ts";

export type ConvergenceRuleKind = "generator" | "scaffold" | "normalizer";

export type ConvergenceRuleCatalogEntry = {
  id: string;
  kind: ConvergenceRuleKind;
  description: string;
  source: "coding-tooling" | "convention" | "local";
  implementation: string;
  technologies: string[];
  defaultMode: "apply";
  mode: ConvergenceRuleMode;
  applicable: boolean;
  details?: Record<string, unknown>;
};

const builtInNormalizerRules = [
  {
    id: "normalizer.oxfmt",
    tool: "oxfmt",
    description: "Apply the repository-declared safe Oxfmt write-mode formatter.",
    technologies: ["javascript", "typescript"],
  },
  {
    id: "normalizer.oxlint-safe-fix",
    tool: "oxlint",
    description: "Apply ordinary Oxlint --fix without stronger or unsafe fix modes.",
    technologies: ["javascript", "typescript"],
  },
  {
    id: "normalizer.rustfmt",
    tool: "cargo-fmt",
    description: "Convert cargo fmt --check into deterministic cargo fmt normalization.",
    technologies: ["rust"],
  },
  {
    id: "normalizer.dotnet-format",
    tool: "dotnet-format",
    description: "Convert dotnet format verification into deterministic formatting.",
    technologies: ["dotnet"],
  },
] as const;

const knownScaffoldExpectations = new Set(["typescript-source-test"]);

function currentFindings(root: string): Finding[] {
  const result = findingsCommand(root, { includeSuppressed: false });
  return Array.isArray(result.data.findings) ? (result.data.findings as Finding[]) : [];
}

export function convergenceRuleCatalog(root: string): ConvergenceRuleCatalogEntry[] {
  const rules: ConvergenceRuleCatalogEntry[] = [];

  for (const generator of generatorCatalog(root)) {
    const id = `generator.${generator.id}`;
    rules.push({
      id,
      kind: "generator",
      description: generator.description,
      source: generator.source,
      implementation: generator.path,
      technologies: generator.technologies,
      defaultMode: "apply",
      mode: convergenceRuleMode(root, id),
      applicable: true,
      details: {
        generatorId: generator.id,
        rules: generator.rules,
        prerequisites: generator.prerequisites,
        postconditions: generator.postconditions,
        composedGenerators: generator.composedGenerators,
      },
    });
  }

  const normalization = planNormalization(root);
  const availableNormalizerRules = new Map<string, string[]>();
  for (const normalizer of normalization.normalizers) {
    const id = normalizerRuleId(normalizer.tool);
    const current = availableNormalizerRules.get(id) ?? [];
    current.push(normalizer.id);
    availableNormalizerRules.set(id, current);
  }
  for (const rule of builtInNormalizerRules) {
    rules.push({
      id: rule.id,
      kind: "normalizer",
      description: rule.description,
      source: "coding-tooling",
      implementation: "src/normalization.ts",
      technologies: [...rule.technologies],
      defaultMode: "apply",
      mode: convergenceRuleMode(root, rule.id),
      applicable: availableNormalizerRules.has(rule.id),
      details: {
        tool: rule.tool,
        instances: (availableNormalizerRules.get(rule.id) ?? []).sort(),
      },
    });
  }

  const findings = currentFindings(root);
  const scaffoldExpectations = new Set(knownScaffoldExpectations);
  for (const finding of findings)
    if (finding.scaffold) scaffoldExpectations.add(finding.expectationId);
  const expectations = new Map(expectationRegistry().map((entry) => [entry.id, entry]));
  for (const expectationId of [...scaffoldExpectations].sort()) {
    const id = scaffoldRuleId(expectationId);
    const matching = findings.filter(
      (finding) => finding.expectationId === expectationId && finding.scaffold !== undefined,
    );
    rules.push({
      id,
      kind: "scaffold",
      description:
        expectations.get(expectationId)?.description ??
        `Apply the deterministic scaffold emitted by ${expectationId}.`,
      source: "coding-tooling",
      implementation: "src/expectations.ts#scaffoldFinding",
      technologies: expectationId === "typescript-source-test" ? ["typescript", "bun"] : [],
      defaultMode: "apply",
      mode: convergenceRuleMode(root, id),
      applicable: matching.length > 0,
      details: {
        expectationId,
        activeFindingIds: matching.map((finding) => finding.id).sort(),
      },
    });
  }

  return rules.sort((left, right) => left.id.localeCompare(right.id));
}

function envelope(
  started: number,
  status: ResultEnvelope<Record<string, unknown>>["status"],
  data: Record<string, unknown>,
  diagnostics: Array<{ code?: string; message: string }> = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "convergence-rules",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function convergenceRulesCommand(
  root: string,
  action: "list" | "describe" | "set",
  id?: string,
  mode?: ConvergenceRuleMode,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  try {
    const catalog = convergenceRuleCatalog(root);
    if (action === "list") {
      return envelope(started, "passed", {
        root,
        ruleCount: catalog.length,
        rules: catalog,
        modes: ["disabled", "suggest", "apply"],
        policy: {
          detectorsRemainActiveWhenMutationIsDisabled: true,
          suggestDoesNotMutate: true,
          applyIsDefault: true,
        },
      });
    }

    if (!id) throw new Error(`${action} requires a convergence rule id`);
    const rule = catalog.find((candidate) => candidate.id === id);
    if (!rule) {
      return envelope(started, "unavailable", { root, id }, [
        { code: "convergence-rule-not-found", message: `Unknown convergence rule: ${id}` },
      ]);
    }

    if (action === "describe") return envelope(started, "passed", { root, rule });
    if (!mode) throw new Error("set requires a convergence rule mode");
    const change = setConvergenceRuleMode(root, id, mode);
    const updated = convergenceRuleCatalog(root).find((candidate) => candidate.id === id)!;
    return envelope(started, "passed", { root, rule: updated, change });
  } catch (error) {
    return envelope(started, "error", { root, action, id, mode }, [
      {
        code: "convergence-rules-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
