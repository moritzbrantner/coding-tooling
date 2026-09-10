import { createHash } from "node:crypto";

import { runPlan } from "./core.ts";
import {
  findingsCommand,
  scaffoldFinding,
  type ExpectationEnvelope,
  type Finding,
} from "./expectations.ts";
import type { ResultEnvelope } from "./model.ts";
import {
  planRemediationCandidates,
  type RemediationCandidate,
} from "./remediation-plan.ts";

export type ConvergenceResult = "converged" | "partial" | "blocked";

export type ConvergenceRound = {
  round: number;
  beforeFingerprint: string;
  afterFingerprint: string;
  targetedFindingIds: string[];
  appliedFindingIds: string[];
  staleFindingIds: string[];
  resolvedFindingIds: string[];
  introducedFindingIds: string[];
};

export type ConvergenceOptions = {
  includeBaseline?: boolean;
  maxRounds?: number;
  verifyTier?: string | null;
};

export type ConvergenceDependencies = {
  findings: (root: string) => ExpectationEnvelope;
  scaffold: (root: string, findingId: string) => ExpectationEnvelope;
  verify: (root: string, tier: string) => ResultEnvelope<Record<string, unknown>>;
};

const defaultDependencies: ConvergenceDependencies = {
  findings: (root) => findingsCommand(root, { includeSuppressed: false }),
  scaffold: scaffoldFinding,
  verify: (root, tier) => runPlan({ root, tier, strict: true }),
};

function findingsFrom(envelope: ExpectationEnvelope): Finding[] {
  return Array.isArray(envelope.data.findings) ? (envelope.data.findings as Finding[]) : [];
}

function selectedFindings(findings: Finding[], includeBaseline: boolean): Finding[] {
  return findings
    .filter(
      (finding) =>
        finding.disposition === "active" && (includeBaseline || finding.state === "new"),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function stateFingerprint(findings: Finding[]): string {
  const state = findings.map((finding) => ({
    id: finding.id,
    expectationId: finding.expectationId,
    severity: finding.severity,
    state: finding.state,
    scaffold: finding.scaffold?.path,
  }));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

function diagnosticCode(envelope: ExpectationEnvelope, code: string): boolean {
  return envelope.diagnostics.some((diagnostic) => diagnostic.code === code);
}

function handoffCandidates(
  findings: Finding[],
  includeBaseline: boolean,
): RemediationCandidate[] {
  return planRemediationCandidates(findings, { includeBaseline }).filter(
    (candidate) => candidate.kind !== "deterministic-scaffold",
  );
}

function finish(
  started: number,
  root: string,
  result: Exclude<ConvergenceResult, "blocked">,
  initialFindingIds: string[],
  finalFindings: Finding[],
  rounds: ConvergenceRound[],
  options: Required<Pick<ConvergenceOptions, "includeBaseline" | "maxRounds">> & {
    verifyTier: string | null;
  },
  dependencies: ConvergenceDependencies,
): ResultEnvelope<Record<string, unknown>> {
  const verification = options.verifyTier
    ? dependencies.verify(root, options.verifyTier)
    : undefined;
  const status = verification ? verification.status : "passed";
  const finalFindingIds = finalFindings.map((finding) => finding.id).sort();
  const handoff = handoffCandidates(finalFindings, options.includeBaseline);

  return {
    schemaVersion: 1,
    operation: "converge",
    status,
    durationMs: Date.now() - started,
    data: {
      root,
      result,
      includeBaseline: options.includeBaseline,
      maxRounds: options.maxRounds,
      verifyTier: options.verifyTier,
      initialFindingIds,
      finalFindingIds,
      rounds,
      handoff,
      verification,
      policy: {
        deterministicMutationOnly: true,
        baselineDebtRequiresOptIn: true,
        collisionHandling: "fail-closed",
        cycleDetection: "finding-state-fingerprint",
        generatedFilesBecomeUserOwned: true,
      },
    },
    diagnostics: verification?.diagnostics ?? [],
  };
}

function blocked(
  started: number,
  root: string,
  reason: string,
  message: string,
  initialFindingIds: string[],
  currentFindings: Finding[],
  rounds: ConvergenceRound[],
  options: Required<Pick<ConvergenceOptions, "includeBaseline" | "maxRounds">> & {
    verifyTier: string | null;
  },
  extra: Record<string, unknown> = {},
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "converge",
    status: "failed",
    durationMs: Date.now() - started,
    data: {
      root,
      result: "blocked",
      reason,
      includeBaseline: options.includeBaseline,
      maxRounds: options.maxRounds,
      verifyTier: options.verifyTier,
      initialFindingIds,
      finalFindingIds: currentFindings.map((finding) => finding.id).sort(),
      rounds,
      handoff: handoffCandidates(currentFindings, options.includeBaseline),
      ...extra,
    },
    diagnostics: [{ code: reason, message }],
  };
}

export function convergeRepository(
  root: string,
  options: ConvergenceOptions = {},
  dependencies: ConvergenceDependencies = defaultDependencies,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const includeBaseline = options.includeBaseline === true;
  const maxRounds = options.maxRounds ?? 16;
  const verifyTier = options.verifyTier === undefined ? "fast" : options.verifyTier;
  const resolvedOptions = { includeBaseline, maxRounds, verifyTier };

  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) {
    return blocked(
      started,
      root,
      "invalid-convergence-limit",
      "maxRounds must be an integer between 1 and 100",
      [],
      [],
      [],
      resolvedOptions,
    );
  }

  const rounds: ConvergenceRound[] = [];
  const seen = new Set<string>();
  let initialFindingIds: string[] = [];
  let finalFindings: Finding[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const beforeEnvelope = dependencies.findings(root);
    if (beforeEnvelope.status === "error" || beforeEnvelope.status === "unavailable") {
      return {
        schemaVersion: 1,
        operation: "converge",
        status: beforeEnvelope.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          reason: "findings-unavailable",
          rounds,
        },
        diagnostics: beforeEnvelope.diagnostics,
      };
    }

    const before = selectedFindings(findingsFrom(beforeEnvelope), includeBaseline);
    const beforeIds = before.map((finding) => finding.id);
    if (round === 1) initialFindingIds = beforeIds;

    const beforeFingerprint = stateFingerprint(before);
    if (seen.has(beforeFingerprint)) {
      return blocked(
        started,
        root,
        "convergence-cycle",
        "Deterministic remediation returned to an already observed finding state",
        initialFindingIds,
        before,
        rounds,
        resolvedOptions,
      );
    }
    seen.add(beforeFingerprint);

    const candidates = planRemediationCandidates(before, { includeBaseline });
    const deterministic = candidates.filter(
      (candidate) => candidate.kind === "deterministic-scaffold",
    );
    if (deterministic.length === 0) {
      return finish(
        started,
        root,
        before.length === 0 ? "converged" : "partial",
        initialFindingIds,
        before,
        rounds,
        resolvedOptions,
        dependencies,
      );
    }

    const targetedFindingIds = deterministic
      .flatMap((candidate) => candidate.scaffolds.map((scaffold) => scaffold.findingId))
      .sort();
    const appliedFindingIds: string[] = [];
    const staleFindingIds: string[] = [];

    for (const findingId of targetedFindingIds) {
      const scaffold = dependencies.scaffold(root, findingId);
      if (scaffold.status === "passed") {
        appliedFindingIds.push(findingId);
        continue;
      }
      if (scaffold.status === "unavailable" && diagnosticCode(scaffold, "finding-not-found")) {
        staleFindingIds.push(findingId);
        continue;
      }
      return blocked(
        started,
        root,
        "convergence-scaffold-failed",
        `Deterministic scaffold ${findingId} could not be applied safely`,
        initialFindingIds,
        before,
        rounds,
        resolvedOptions,
        { findingId, scaffold },
      );
    }

    const afterEnvelope = dependencies.findings(root);
    if (afterEnvelope.status === "error" || afterEnvelope.status === "unavailable") {
      return {
        schemaVersion: 1,
        operation: "converge",
        status: afterEnvelope.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          reason: "findings-unavailable-after-scaffold",
          rounds,
        },
        diagnostics: afterEnvelope.diagnostics,
      };
    }

    const after = selectedFindings(findingsFrom(afterEnvelope), includeBaseline);
    finalFindings = after;
    const afterIds = after.map((finding) => finding.id);
    const afterFingerprint = stateFingerprint(after);
    const resolvedFindingIds = difference(beforeIds, afterIds);
    const introducedFindingIds = difference(afterIds, beforeIds);

    rounds.push({
      round,
      beforeFingerprint,
      afterFingerprint,
      targetedFindingIds,
      appliedFindingIds,
      staleFindingIds,
      resolvedFindingIds,
      introducedFindingIds,
    });

    if (afterFingerprint === beforeFingerprint) {
      return blocked(
        started,
        root,
        "convergence-no-progress",
        "Deterministic remediation completed without changing the finding state",
        initialFindingIds,
        after,
        rounds,
        resolvedOptions,
      );
    }
    if (seen.has(afterFingerprint)) {
      return blocked(
        started,
        root,
        "convergence-cycle",
        "Deterministic remediation produced an already observed finding state",
        initialFindingIds,
        after,
        rounds,
        resolvedOptions,
      );
    }
  }

  const finalDeterministic = planRemediationCandidates(finalFindings, { includeBaseline }).filter(
    (candidate) => candidate.kind === "deterministic-scaffold",
  );
  if (finalDeterministic.length === 0) {
    return finish(
      started,
      root,
      finalFindings.length === 0 ? "converged" : "partial",
      initialFindingIds,
      finalFindings,
      rounds,
      resolvedOptions,
      dependencies,
    );
  }

  return blocked(
    started,
    root,
    "convergence-round-limit",
    `Deterministic remediation did not reach a fixed point within ${maxRounds} rounds`,
    initialFindingIds,
    finalFindings,
    rounds,
    resolvedOptions,
  );
}
