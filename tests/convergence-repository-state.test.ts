import { expect, test } from "bun:test";

import { convergeRepository, type ConvergenceDependencies } from "../src/convergence.ts";
import type { ExpectationEnvelope } from "../src/expectations.ts";
import type { RepositoryMergeReadiness } from "../src/merge-readiness.ts";
import type { ResultEnvelope, ResultOperation, ResultStatus } from "../src/model.ts";

function findingsEnvelope(operation: "findings" | "scaffold" = "findings"): ExpectationEnvelope {
  return {
    schemaVersion: 1,
    operation,
    status: "passed",
    durationMs: 0,
    data: { findings: [] },
    diagnostics: [],
  };
}

function resultEnvelope(
  operation: ResultOperation,
  status: ResultStatus = "passed",
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: 0,
    data: {},
    diagnostics:
      status === "passed"
        ? []
        : [{ code: `${operation}-${status}`, message: `${operation} ${status}` }],
  };
}

function readiness(state: RepositoryMergeReadiness["readiness"]): RepositoryMergeReadiness {
  return {
    name: "fixture",
    root: "/repo",
    repository: "owner/repository",
    readiness: state,
    blockers:
      state === "trusted-auto-merge" || state === "local-gated"
        ? []
        : [{ code: "merge-target-branch-unprotected", message: "main is not protected" }],
    evidence: {
      foundationStatus: "passed",
      mergeAuthority: state === "local-gated" ? "local" : "hosted",
      mergeReason: state === "local-gated" ? "local hardware" : null,
      requiredChecks: state === "local-gated" ? [] : ["Validate"],
      localOnlySourceGraph: false,
      remote: null,
    },
  };
}

function dependencies(overrides: Partial<ConvergenceDependencies>): ConvergenceDependencies {
  return {
    findings: () => findingsEnvelope(),
    scaffold: () => findingsEnvelope("scaffold"),
    normalize: () => resultEnvelope("normalize"),
    stateFingerprint: () => "stable",
    verify: () => resultEnvelope("run"),
    ...overrides,
  };
}

test("does not call an unprotected hosted repository converged", () => {
  const result = convergeRepository(
    "/repo",
    {},
    dependencies({
      readiness: () => readiness("protection-required"),
      reconcilePullRequests: () => resultEnvelope("pr-reconciliation"),
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "partial",
    repositoryReadiness: { readiness: "protection-required" },
  });
  expect(result.data.convergenceBlockers).toEqual([
    { code: "merge-target-branch-unprotected", message: "main is not protected" },
  ]);
});

test("does not call a repository converged while open PR topology needs reconciliation", () => {
  const result = convergeRepository(
    "/repo",
    {},
    dependencies({
      readiness: () => readiness("trusted-auto-merge"),
      reconcilePullRequests: () => resultEnvelope("pr-reconciliation", "failed"),
    }),
  );

  expect(result.data).toMatchObject({ result: "partial" });
  expect(result.data.convergenceBlockers).toEqual([
    { code: "pr-reconciliation-failed", message: "pr-reconciliation failed" },
  ]);
});

test("accepts local-gated repositories when their open PR topology is reconciled", () => {
  const result = convergeRepository(
    "/repo",
    {},
    dependencies({
      readiness: () => readiness("local-gated"),
      reconcilePullRequests: () => resultEnvelope("pr-reconciliation"),
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "converged",
    repositoryReadiness: { readiness: "local-gated" },
  });
  expect(result.data.convergenceBlockers).toEqual([]);
});
