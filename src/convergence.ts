import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runPlan } from "./core.ts";
import {
  findingsCommand,
  scaffoldFinding,
  type ExpectationEnvelope,
  type Finding,
} from "./expectations.ts";
import { repositoryMergeReadiness, type RepositoryMergeReadiness } from "./merge-readiness.ts";
import type { Diagnostic, ResultEnvelope } from "./model.ts";
import { normalizeRepository, repositoryContentFingerprint } from "./normalization.ts";
import { openPullRequestReconciliation } from "./open-pr-reconciliation.ts";
import { planRemediationCandidates, type RemediationCandidate } from "./remediation-plan.ts";

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
  normalize?: (root: string) => ResultEnvelope<Record<string, unknown>>;
  stateFingerprint?: (root: string, findings: Finding[]) => string;
  verify: (root: string, tier: string) => ResultEnvelope<Record<string, unknown>>;
  readiness?: (root: string) => RepositoryMergeReadiness | undefined;
  reconcilePullRequests?: (root: string) => ResultEnvelope<Record<string, unknown>> | undefined;
};

const progressiveVerificationTiers = ["fast", "integration", "workflow", "e2e"] as const;

type VerificationApplicability = "applicable" | "not-applicable";

type ConvergenceVerification = {
  tier: string;
  applicability: VerificationApplicability;
  result: ResultEnvelope<Record<string, unknown>>;
};

function findingState(findings: Finding[]): Array<Record<string, unknown>> {
  return findings.map((finding) => ({
    id: finding.id,
    expectationId: finding.expectationId,
    severity: finding.severity,
    state: finding.state,
    scaffold: finding.scaffold?.path,
  }));
}

function repositoryStateFingerprint(root: string, findings: Finding[]): string {
  return createHash("sha256")
    .update(repositoryContentFingerprint(root))
    .update("\0")
    .update(JSON.stringify(findingState(findings)))
    .digest("hex");
}

function hasGitMetadata(root: string): boolean {
  return existsSync(join(root, ".git"));
}

const defaultDependencies: ConvergenceDependencies = {
  findings: (root) => findingsCommand(root, { includeSuppressed: false }),
  scaffold: scaffoldFinding,
  normalize: normalizeRepository,
  stateFingerprint: repositoryStateFingerprint,
  verify: (root, tier) => runPlan({ root, tier, strict: true }),
  readiness: (root) => (hasGitMetadata(root) ? repositoryMergeReadiness(root) : undefined),
  reconcilePullRequests: (root) =>
    hasGitMetadata(root) ? openPullRequestReconciliation(root) : undefined,
};

function findingsFrom(envelope: ExpectationEnvelope): Finding[] {
  return Array.isArray(envelope.data.findings) ? (envelope.data.findings as Finding[]) : [];
}

function selectedFindings(findings: Finding[], includeBaseline: boolean): Finding[] {
  return findings
    .filter(
      (finding) => finding.disposition === "active" && (includeBaseline || finding.state === "new"),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

function diagnosticCode(envelope: ExpectationEnvelope, code: string): boolean {
  return envelope.diagnostics.some((diagnostic) => diagnostic.code === code);
}

function handoffCandidates(findings: Finding[], includeBaseline: boolean): RemediationCandidate[] {
  return planRemediationCandidates(findings, { includeBaseline }).filter(
    (candidate) => candidate.kind !== "deterministic-scaffold",
  );
}

function readinessAllowsConvergence(readiness: RepositoryMergeReadiness): boolean {
  if (readiness.readiness === "trusted-auto-merge") return true;
  return readiness.readiness === "local-gated" && readiness.blockers.length === 0;
}

function verificationTiersThrough(target: string | null, sourceFixedPoint: boolean): string[] {
  if (!target) return [];
  const index = progressiveVerificationTiers.indexOf(
    target as (typeof progressiveVerificationTiers)[number],
  );
  if (index < 0) return [target];
  const tiers = progressiveVerificationTiers.slice(0, index + 1);
  return sourceFixedPoint ? [...tiers] : tiers.slice(0, 1);
}

function verificationApplicability(
  verification: ResultEnvelope<Record<string, unknown>>,
): VerificationApplicability {
  if (verification.status !== "passed") return "applicable";
  const checks = verification.data.checks;
  const missing = verification.data.missing;
  if (!Array.isArray(checks) || !Array.isArray(missing)) return "applicable";
  if (checks.length > 0) return "applicable";
  const requiredMissing = missing.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "optional" in item &&
      (item as { optional?: unknown }).optional === false,
  );
  return requiredMissing ? "applicable" : "not-applicable";
}

function finish(
  started: number,
  root: string,
  result: Exclude<ConvergenceResult, "blocked">,
  initialFindingIds: string[],
  finalFindings: Finding[],
  rounds: ConvergenceRound[],
  normalizations: ResultEnvelope<Record<string, unknown>>[],
  options: Required<Pick<ConvergenceOptions, "includeBaseline" | "maxRounds">> & {
    verifyTier: string | null;
  },
  dependencies: ConvergenceDependencies,
): ResultEnvelope<Record<string, unknown>> {
  const sourceFixedPoint = result === "converged";
  const requestedVerificationTiers = verificationTiersThrough(options.verifyTier, sourceFixedPoint);
  const verifications: ConvergenceVerification[] = [];
  let verification: ResultEnvelope<Record<string, unknown>> | undefined;
  let verificationPassed = true;

  for (const tier of requestedVerificationTiers) {
    const current = dependencies.verify(root, tier);
    const applicability = verificationApplicability(current);
    verifications.push({ tier, applicability, result: current });
    verification = current;
    if (applicability === "not-applicable") continue;
    if (current.status !== "passed") {
      verificationPassed = false;
      break;
    }
  }

  const verificationDiagnostics = verifications.flatMap(
    ({ result: attempted }) => attempted.diagnostics,
  );
  const status = verificationPassed ? "passed" : (verification?.status ?? "failed");
  const finalFindingIds = finalFindings.map((finding) => finding.id).sort();
  const handoff = handoffCandidates(finalFindings, options.includeBaseline);
  const repositoryReadiness =
    sourceFixedPoint && verificationPassed ? dependencies.readiness?.(root) : undefined;
  const pullRequestReconciliation =
    sourceFixedPoint && verificationPassed ? dependencies.reconcilePullRequests?.(root) : undefined;
  const convergenceBlockers: Diagnostic[] = [];

  if (sourceFixedPoint && !verificationPassed) {
    convergenceBlockers.push({
      code: "convergence-verification-incomplete",
      message: `Verification promotion stopped at ${verifications.at(-1)?.tier ?? options.verifyTier ?? "unknown"}`,
    });
  }
  if (repositoryReadiness && !readinessAllowsConvergence(repositoryReadiness)) {
    convergenceBlockers.push(
      ...(repositoryReadiness.blockers.length > 0
        ? repositoryReadiness.blockers
        : [
            {
              code: "convergence-repository-readiness-incomplete",
              message: `Repository readiness is ${repositoryReadiness.readiness}`,
            },
          ]),
    );
  }
  if (pullRequestReconciliation && pullRequestReconciliation.status !== "passed") {
    convergenceBlockers.push(
      ...(pullRequestReconciliation.diagnostics.length > 0
        ? pullRequestReconciliation.diagnostics
        : [
            {
              code: "convergence-pr-reconciliation-incomplete",
              message: `Open pull-request reconciliation is ${pullRequestReconciliation.status}`,
            },
          ]),
    );
  }

  const resolvedResult =
    result === "converged" && convergenceBlockers.length > 0 ? "partial" : result;

  return {
    schemaVersion: 1,
    operation: "converge",
    status,
    durationMs: Date.now() - started,
    data: {
      root,
      result: resolvedResult,
      sourceFixedPoint,
      includeBaseline: options.includeBaseline,
      maxRounds: options.maxRounds,
      verifyTier: options.verifyTier,
      requestedVerificationTiers,
      initialFindingIds,
      finalFindingIds,
      rounds,
      normalizations,
      handoff,
      verification,
      verifications,
      repositoryReadiness,
      pullRequestReconciliation,
      convergenceBlockers,
      policy: {
        deterministicMutationOnly: true,
        baselineDebtRequiresOptIn: true,
        collisionHandling: "fail-closed",
        cycleDetection: "repository-content-and-finding-state-fingerprint",
        normalization: "closed-adapters-with-idempotence-proof",
        generatedFilesBecomeUserOwned: true,
        verificationPromotion: "fast-integration-workflow-e2e",
        repositoryStateGate: "after-required-verification",
      },
    },
    diagnostics: verificationDiagnostics,
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
  normalizations: ResultEnvelope<Record<string, unknown>>[],
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
      normalizations,
      handoff: handoffCandidates(currentFindings, options.includeBaseline),
      ...extra,
    },
    diagnostics: [{ code: reason, message }],
  };
}

function readSelectedFindings(
  root: string,
  includeBaseline: boolean,
  dependencies: ConvergenceDependencies,
  reason: string,
): { findings?: Finding[]; envelope: ExpectationEnvelope; reason: string } {
  const envelope = dependencies.findings(root);
  return {
    envelope,
    reason,
    findings:
      envelope.status === "error" || envelope.status === "unavailable"
        ? undefined
        : selectedFindings(findingsFrom(envelope), includeBaseline),
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
  const normalize = dependencies.normalize ?? defaultDependencies.normalize!;
  const stateFingerprint = dependencies.stateFingerprint ?? defaultDependencies.stateFingerprint!;

  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) {
    return blocked(
      started,
      root,
      "invalid-convergence-limit",
      "maxRounds must be an integer between 1 and 100",
      [],
      [],
      [],
      [],
      resolvedOptions,
    );
  }

  const rounds: ConvergenceRound[] = [];
  const normalizations: ResultEnvelope<Record<string, unknown>>[] = [];
  const seen = new Set<string>();
  let initialFindingIds: string[] = [];
  let finalFindings: Finding[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const observed = readSelectedFindings(
      root,
      includeBaseline,
      dependencies,
      "findings-unavailable",
    );
    if (!observed.findings) {
      return {
        schemaVersion: 1,
        operation: "converge",
        status: observed.envelope.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          reason: observed.reason,
          rounds,
          normalizations,
        },
        diagnostics: observed.envelope.diagnostics,
      };
    }

    let before = observed.findings;
    let beforeIds = before.map((finding) => finding.id);
    if (round === 1) initialFindingIds = beforeIds;

    let beforeFingerprint = stateFingerprint(root, before);
    if (seen.has(beforeFingerprint)) {
      return blocked(
        started,
        root,
        "convergence-cycle",
        "Deterministic remediation returned to an already observed repository/finding state",
        initialFindingIds,
        before,
        rounds,
        normalizations,
        resolvedOptions,
      );
    }
    seen.add(beforeFingerprint);

    let deterministic = planRemediationCandidates(before, { includeBaseline }).filter(
      (candidate) => candidate.kind === "deterministic-scaffold",
    );

    if (deterministic.length === 0) {
      const normalization = normalize(root);
      normalizations.push(normalization);
      if (normalization.status !== "passed") {
        return blocked(
          started,
          root,
          "convergence-normalization-failed",
          "Deterministic normalization did not reach an idempotent fixed point",
          initialFindingIds,
          before,
          rounds,
          normalizations,
          resolvedOptions,
          { normalization },
        );
      }

      const normalizedObservation = readSelectedFindings(
        root,
        includeBaseline,
        dependencies,
        "findings-unavailable-after-normalization",
      );
      if (!normalizedObservation.findings) {
        return {
          schemaVersion: 1,
          operation: "converge",
          status: normalizedObservation.envelope.status,
          durationMs: Date.now() - started,
          data: {
            root,
            result: "blocked",
            reason: normalizedObservation.reason,
            rounds,
            normalizations,
          },
          diagnostics: normalizedObservation.envelope.diagnostics,
        };
      }

      before = normalizedObservation.findings;
      finalFindings = before;
      deterministic = planRemediationCandidates(before, { includeBaseline }).filter(
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
          normalizations,
          resolvedOptions,
          dependencies,
        );
      }

      beforeIds = before.map((finding) => finding.id);
      beforeFingerprint = stateFingerprint(root, before);
      if (seen.has(beforeFingerprint)) {
        return blocked(
          started,
          root,
          "convergence-cycle",
          "Normalization returned to an already observed repository/finding state with deterministic work remaining",
          initialFindingIds,
          before,
          rounds,
          normalizations,
          resolvedOptions,
        );
      }
      seen.add(beforeFingerprint);
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
        normalizations,
        resolvedOptions,
        { findingId, scaffold },
      );
    }

    const afterObservation = readSelectedFindings(
      root,
      includeBaseline,
      dependencies,
      "findings-unavailable-after-scaffold",
    );
    if (!afterObservation.findings) {
      return {
        schemaVersion: 1,
        operation: "converge",
        status: afterObservation.envelope.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          reason: afterObservation.reason,
          rounds,
          normalizations,
        },
        diagnostics: afterObservation.envelope.diagnostics,
      };
    }

    const after = afterObservation.findings;
    finalFindings = after;
    const afterIds = after.map((finding) => finding.id);
    const afterFingerprint = stateFingerprint(root, after);
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
        "Deterministic remediation completed without changing repository content or finding state",
        initialFindingIds,
        after,
        rounds,
        normalizations,
        resolvedOptions,
      );
    }
    if (seen.has(afterFingerprint)) {
      return blocked(
        started,
        root,
        "convergence-cycle",
        "Deterministic remediation produced an already observed repository/finding state",
        initialFindingIds,
        after,
        rounds,
        normalizations,
        resolvedOptions,
      );
    }
  }

  const finalDeterministic = planRemediationCandidates(finalFindings, { includeBaseline }).filter(
    (candidate) => candidate.kind === "deterministic-scaffold",
  );
  if (finalDeterministic.length === 0) {
    const normalization = normalize(root);
    normalizations.push(normalization);
    if (normalization.status !== "passed") {
      return blocked(
        started,
        root,
        "convergence-normalization-failed",
        "Deterministic normalization did not reach an idempotent fixed point",
        initialFindingIds,
        finalFindings,
        rounds,
        normalizations,
        resolvedOptions,
        { normalization },
      );
    }

    const normalizedObservation = readSelectedFindings(
      root,
      includeBaseline,
      dependencies,
      "findings-unavailable-after-normalization",
    );
    if (!normalizedObservation.findings) {
      return {
        schemaVersion: 1,
        operation: "converge",
        status: normalizedObservation.envelope.status,
        durationMs: Date.now() - started,
        data: {
          root,
          result: "blocked",
          reason: normalizedObservation.reason,
          rounds,
          normalizations,
        },
        diagnostics: normalizedObservation.envelope.diagnostics,
      };
    }

    const normalized = normalizedObservation.findings;
    const deterministicAfterNormalization = planRemediationCandidates(normalized, {
      includeBaseline,
    }).filter((candidate) => candidate.kind === "deterministic-scaffold");
    if (deterministicAfterNormalization.length === 0) {
      return finish(
        started,
        root,
        normalized.length === 0 ? "converged" : "partial",
        initialFindingIds,
        normalized,
        rounds,
        normalizations,
        resolvedOptions,
        dependencies,
      );
    }
    finalFindings = normalized;
  }

  return blocked(
    started,
    root,
    "convergence-round-limit",
    `Deterministic remediation did not reach a fixed point within ${maxRounds} rounds`,
    initialFindingIds,
    finalFindings,
    rounds,
    normalizations,
    resolvedOptions,
  );
}
