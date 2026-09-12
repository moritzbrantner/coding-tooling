import { expect, test } from "bun:test";

import { convergeRepository, type ConvergenceDependencies } from "../src/convergence.ts";
import type { ExpectationEnvelope, Finding, FindingScaffold } from "../src/expectations.ts";
import type { ResultEnvelope, ResultStatus } from "../src/model.ts";

function finding(
  id: string,
  subjectKey: string,
  scaffold?: FindingScaffold,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id,
    expectationId: "source-test-reachability",
    expectationVersion: 1,
    policyKind: "advisory",
    severity: "warning",
    state: "new",
    disposition: "active",
    subject: {
      kind: "file",
      key: subjectKey,
      path: subjectKey,
      description: subjectKey,
    },
    requirement: {
      kind: "test",
      key: "test-reachability",
      description: "source is reachable from tests",
    },
    message: "missing deterministic evidence",
    evidence: [{ kind: "file", path: subjectKey, detail: "production source" }],
    relatedFiles: [subjectKey],
    verification: [],
    relationships: [],
    scaffold,
    ...overrides,
  };
}

function findingsEnvelope(
  findings: Finding[],
  status: ResultStatus = "passed",
): ExpectationEnvelope {
  return {
    schemaVersion: 1,
    operation: "findings",
    status,
    durationMs: 0,
    data: { findings },
    diagnostics: [],
  };
}

function scaffoldEnvelope(status: ResultStatus = "passed", code?: string): ExpectationEnvelope {
  return {
    schemaVersion: 1,
    operation: "scaffold",
    status,
    durationMs: 0,
    data: {},
    diagnostics: code ? [{ code, message: code }] : [],
  };
}

function verificationEnvelope(
  status: ResultStatus = "passed",
  tier = "fast",
  data: Record<string, unknown> = {},
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "run",
    status,
    durationMs: 0,
    data: { tier, ...data },
    diagnostics: status === "passed" ? [] : [{ code: "validation-failed", message: status }],
  };
}

test("applies deterministic scaffolds until the finding state reaches a fixed point", () => {
  const states = [
    [
      finding("CT-AAAAAAAAAAAA", "src/first.ts", {
        kind: "create-file",
        path: "tests/first.test.ts",
        content: "first\n",
      }),
    ],
    [
      finding("CT-BBBBBBBBBBBB", "src/second.ts", {
        kind: "create-file",
        path: "tests/second.test.ts",
        content: "second\n",
      }),
    ],
    [],
  ];
  let state = 0;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope(states[state]!),
    scaffold: (_root, id) => {
      if ((state === 0 && id === "CT-AAAAAAAAAAAA") || (state === 1 && id === "CT-BBBBBBBBBBBB")) {
        state += 1;
        return scaffoldEnvelope();
      }
      return scaffoldEnvelope("unavailable", "finding-not-found");
    },
    verify: (_root, tier) => verificationEnvelope("passed", tier),
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "converged",
    sourceFixedPoint: true,
    initialFindingIds: ["CT-AAAAAAAAAAAA"],
    finalFindingIds: [],
    verifyTier: "fast",
    requestedVerificationTiers: ["fast"],
  });
  expect(result.data.rounds).toHaveLength(2);
});

test("stops at a deterministic fixed point and returns remaining work as an agent handoff", () => {
  const scaffolded = finding("CT-CCCCCCCCCCCC", "src/feature.ts", {
    kind: "create-file",
    path: "src/feature.generated.ts",
    content: "// TODO: implement behavior\n",
  });
  const todo = finding("CT-DDDDDDDDDDDD", "src/feature.generated.ts", undefined, {
    expectationId: "source-debt-marker",
    severity: "info",
    requirement: {
      kind: "signal",
      key: "resolve-debt-marker",
      description: "resolve generated implementation marker",
    },
    message: "generated implementation marker remains",
  });
  let state = 0;
  let verifiedTier: string | undefined;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope(state === 0 ? [scaffolded] : [todo]),
    scaffold: () => {
      state = 1;
      return scaffoldEnvelope();
    },
    verify: (_root, tier) => {
      verifiedTier = tier;
      return verificationEnvelope("passed", tier);
    },
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("passed");
  expect(verifiedTier).toBe("fast");
  expect(result.data).toMatchObject({
    result: "partial",
    sourceFixedPoint: false,
    finalFindingIds: ["CT-DDDDDDDDDDDD"],
    handoff: [
      {
        kind: "review",
        findingIds: ["CT-DDDDDDDDDDDD"],
        relatedFiles: ["src/feature.generated.ts"],
      },
    ],
  });
});

test("promotes a clean fixed point through the layered verification ladder", () => {
  const verifiedTiers: string[] = [];
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([]),
    scaffold: () => scaffoldEnvelope(),
    verify: (_root, tier) => {
      verifiedTiers.push(tier);
      return verificationEnvelope("passed", tier);
    },
  };

  const result = convergeRepository("/repo", { verifyTier: "e2e" }, dependencies);

  expect(result.status).toBe("passed");
  expect(verifiedTiers).toEqual(["fast", "integration", "workflow", "e2e"]);
  expect(result.data).toMatchObject({
    result: "converged",
    sourceFixedPoint: true,
    requestedVerificationTiers: ["fast", "integration", "workflow", "e2e"],
  });
});

test("stops layered verification at a failed empty layer before repository readiness", () => {
  const verifiedTiers: string[] = [];
  let readinessCalls = 0;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([]),
    scaffold: () => scaffoldEnvelope(),
    verify: (_root, tier) => {
      verifiedTiers.push(tier);
      return verificationEnvelope(tier === "integration" ? "failed" : "passed", tier, {
        checks: [],
        missing: [],
      });
    },
    readiness: () => {
      readinessCalls += 1;
      return undefined;
    },
  };

  const result = convergeRepository("/repo", { verifyTier: "e2e" }, dependencies);

  expect(result.status).toBe("failed");
  expect(verifiedTiers).toEqual(["fast", "integration"]);
  expect(readinessCalls).toBe(0);
  expect(result.data).toMatchObject({
    result: "partial",
    sourceFixedPoint: true,
    convergenceBlockers: [{ code: "convergence-verification-incomplete" }],
  });
});

test("treats an absent higher layer as not applicable without blocking later layers", () => {
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([]),
    scaffold: () => scaffoldEnvelope(),
    verify: (_root, tier) => {
      const verification = verificationEnvelope(
        "passed",
        tier,
        tier === "integration"
          ? { checks: [], missing: [] }
          : { checks: [{ capability: tier }], missing: [] },
      );
      if (tier === "integration") {
        verification.diagnostics = [
          {
            code: "optional-capability-unavailable",
            message: "integration is optional and unavailable",
          },
        ];
      }
      return verification;
    },
  };

  const result = convergeRepository("/repo", { verifyTier: "workflow" }, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data.result).toBe("converged");
  expect(result.data.verifications).toEqual([
    expect.objectContaining({ tier: "fast", applicability: "applicable" }),
    expect.objectContaining({ tier: "integration", applicability: "not-applicable" }),
    expect.objectContaining({ tier: "workflow", applicability: "applicable" }),
  ]);
  expect(result.diagnostics).toEqual([
    {
      code: "optional-capability-unavailable",
      message: "integration is optional and unavailable",
    },
  ]);
});

test("does not promote beyond fast while semantic handoff work remains", () => {
  const handoff = finding("CT-121212121212", "src/semantic.ts", undefined, {
    expectationId: "source-debt-marker",
    severity: "info",
    requirement: {
      kind: "signal",
      key: "resolve-debt-marker",
      description: "resolve semantic work",
    },
  });
  const verifiedTiers: string[] = [];
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([handoff]),
    scaffold: () => scaffoldEnvelope(),
    verify: (_root, tier) => {
      verifiedTiers.push(tier);
      return verificationEnvelope("passed", tier);
    },
  };

  const result = convergeRepository("/repo", { verifyTier: "e2e" }, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data.result).toBe("partial");
  expect(verifiedTiers).toEqual(["fast"]);
});

test("detects oscillation instead of replaying deterministic scaffolds forever", () => {
  const first = finding("CT-EEEEEEEEEEEE", "src/first.ts", {
    kind: "create-file",
    path: "src/first.generated.ts",
    content: "first\n",
  });
  const second = finding("CT-FFFFFFFFFFFF", "src/second.ts", {
    kind: "create-file",
    path: "src/second.generated.ts",
    content: "second\n",
  });
  let state = 0;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope(state === 0 ? [first] : [second]),
    scaffold: () => {
      state = state === 0 ? 1 : 0;
      return scaffoldEnvelope();
    },
    verify: () => verificationEnvelope(),
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("failed");
  expect(result.data).toMatchObject({ result: "blocked", reason: "convergence-cycle" });
  expect(result.diagnostics[0]?.code).toBe("convergence-cycle");
});

test("fails closed when a scaffold cannot be applied safely", () => {
  const current = finding("CT-111111111111", "src/conflict.ts", {
    kind: "create-file",
    path: "src/conflict.generated.ts",
    content: "generated\n",
  });
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([current]),
    scaffold: () => scaffoldEnvelope("failed", "generation-conflict"),
    verify: () => verificationEnvelope(),
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("failed");
  expect(result.data).toMatchObject({
    result: "blocked",
    reason: "convergence-scaffold-failed",
    findingId: "CT-111111111111",
  });
});

test("keeps a clean source fixed point distinct from failed verification", () => {
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope([]),
    scaffold: () => scaffoldEnvelope(),
    verify: () => verificationEnvelope("failed"),
  };

  const result = convergeRepository("/repo", {}, dependencies);

  expect(result.status).toBe("failed");
  expect(result.data).toMatchObject({
    result: "partial",
    sourceFixedPoint: true,
    finalFindingIds: [],
    convergenceBlockers: [{ code: "convergence-verification-incomplete" }],
  });
  expect(result.diagnostics[0]?.code).toBe("validation-failed");
});

test("returns converged when the final allowed mutation round reaches an empty fixed point", () => {
  const current = finding("CT-222222222222", "src/final.ts", {
    kind: "create-file",
    path: "tests/final.test.ts",
    content: "final\n",
  });
  let state = 0;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope(state === 0 ? [current] : []),
    scaffold: () => {
      state = 1;
      return scaffoldEnvelope();
    },
    verify: () => verificationEnvelope(),
  };

  const result = convergeRepository("/repo", { maxRounds: 1 }, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "converged",
    finalFindingIds: [],
  });
  expect(result.data.rounds).toHaveLength(1);
});

test("returns partial when the final allowed mutation round leaves only agent-owned work", () => {
  const scaffolded = finding("CT-333333333333", "src/final-feature.ts", {
    kind: "create-file",
    path: "src/final-feature.generated.ts",
    content: "// TODO: implement behavior\n",
  });
  const handoff = finding("CT-444444444444", "src/final-feature.generated.ts", undefined, {
    expectationId: "source-debt-marker",
    severity: "info",
    requirement: {
      kind: "signal",
      key: "resolve-debt-marker",
      description: "resolve generated implementation marker",
    },
    message: "generated implementation marker remains",
  });
  let state = 0;
  const dependencies: ConvergenceDependencies = {
    findings: () => findingsEnvelope(state === 0 ? [scaffolded] : [handoff]),
    scaffold: () => {
      state = 1;
      return scaffoldEnvelope();
    },
    verify: () => verificationEnvelope(),
  };

  const result = convergeRepository("/repo", { maxRounds: 1 }, dependencies);

  expect(result.status).toBe("passed");
  expect(result.data).toMatchObject({
    result: "partial",
    finalFindingIds: ["CT-444444444444"],
    handoff: [
      {
        kind: "review",
        findingIds: ["CT-444444444444"],
        relatedFiles: ["src/final-feature.generated.ts"],
      },
    ],
  });
  expect(result.data.rounds).toHaveLength(1);
});
