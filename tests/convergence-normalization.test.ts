import { expect, test } from "bun:test";

import {
  convergeRepository,
  type ConvergenceDependencies,
} from "../src/convergence.ts";
import type { ExpectationEnvelope, Finding } from "../src/expectations.ts";
import type { ResultEnvelope, ResultStatus } from "../src/model.ts";

function finding(): Finding {
  return {
    id: "CT-AAAAAAAAAAAA",
    expectationId: "source-work-marker",
    expectationVersion: 1,
    policyKind: "advisory",
    severity: "info",
    state: "new",
    disposition: "active",
    subject: {
      kind: "file",
      key: "src/feature.ts#coding-tooling:implement",
      path: "src/feature.ts",
      description: "generated implementation work",
    },
    requirement: {
      kind: "signal",
      key: "resolve-work-marker:implement",
      description: "implement generated behavior",
    },
    message: "implement generated behavior",
    evidence: [{ kind: "file", path: "src/feature.ts", detail: "work marker" }],
    relatedFiles: ["src/feature.ts"],
    verification: [],
    relationships: [],
  };
}

function findingsEnvelope(items: Finding[]): ExpectationEnvelope {
  return {
    schemaVersion: 1,
    operation: "findings",
    status: "passed",
    durationMs: 0,
    data: { findings: items },
    diagnostics: [],
  };
}

function normalizationEnvelope(
  status: ResultStatus = "passed",
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "normalize",
    status,
    durationMs: 0,
    data: {
      result: status === "passed" ? "normalized" : "blocked",
      idempotent: status === "passed",
    },
    diagnostics:
      status === "passed"
        ? []
        : [{ code: "normalization-not-idempotent", message: "normalization changed twice" }],
  };
}

function verificationEnvelope(): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "run",
    status: "passed",
    durationMs: 0,
    data: { tier: "fast" },
    diagnostics: [],
  };
}

test("normalizes at the deterministic fixed point before validation and agent handoff", () => {
  const order: string[] = [];
  const remaining = finding();
  const dependencies: ConvergenceDependencies = {
    findings: () => {
      order.push("findings");
      return findingsEnvelope([remaining]);
    },
    scaffold: () => {
      throw new Error("no scaffold should run");
    },
    normalize: () => {
      order.push("normalize");
      return normalizationEnvelope();
    },
    verify: () => {
      order.push("verify");
      return verificationEnvelope();
    },
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "partial",
    finalFindingIds: ["CT-AAAAAAAAAAAA"],
  });
  expect(result.data.normalizations).toHaveLength(1);
  expect(order).toEqual(["findings", "normalize", "findings", "verify"]);
});

test("fails before validation when normalization cannot prove an idempotent fixed point", () => {
  let verified = false;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([]),
    scaffold: () => {
      throw new Error("no scaffold should run");
    },
    normalize: () => normalizationEnvelope("failed"),
    verify: () => {
      verified = true;
      return verificationEnvelope();
    },
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("failed");
  expect(result.data).toMatchObject({
    result: "blocked",
    reason: "convergence-normalization-failed",
  });
  expect(verified).toBeFalse();
});

test("re-enters deterministic scaffolding when normalization exposes new mechanical work", () => {
  const mechanical: Finding = {
    ...finding(),
    id: "CT-BBBBBBBBBBBB",
    expectationId: "typescript-source-test",
    severity: "warning",
    subject: {
      kind: "file",
      key: "src/feature.ts",
      path: "src/feature.ts",
      description: "feature source",
    },
    requirement: {
      kind: "test",
      key: "tests/feature.test.ts",
      description: "deterministic test reachability",
    },
    scaffold: {
      kind: "create-file",
      path: "tests/feature.test.ts",
      content: "// generated\n",
    },
  };
  let state = 0;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope(state === 0 ? [] : state === 1 ? [mechanical] : []),
    scaffold: () => {
      state = 2;
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "passed",
        durationMs: 0,
        data: {},
        diagnostics: [],
      };
    },
    normalize: () => {
      if (state === 0) state = 1;
      return normalizationEnvelope();
    },
    stateFingerprint: (_root, findings) =>
      `${state}:${findings.map((item) => item.id).join(",")}`,
    verify: () => verificationEnvelope(),
  };

  const result = convergeRepository("/repo", { maxRounds: 1 }, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({ result: "converged", finalFindingIds: [] });
  expect(result.data.rounds).toHaveLength(1);
  expect(result.data.normalizations).toHaveLength(2);
});
