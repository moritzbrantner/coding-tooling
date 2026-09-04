import { expect, test } from "bun:test";

import type { Finding } from "../src/expectation-model.ts";
import { planRemediationCandidates } from "../src/remediation-plan.ts";

function finding(
  id: string,
  subjectKey: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id,
    expectationId: "source-test-reachability",
    expectationVersion: 1,
    policyKind: "convention",
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
    message: "missing test reachability",
    evidence: [{ kind: "file", path: subjectKey, detail: "production source" }],
    relatedFiles: [subjectKey],
    verification: [["bun", "run", "test"]],
    relationships: [],
    ...overrides,
  };
}

test("groups related active findings into one subject-scoped candidate", () => {
  const first = finding("CT-AAAAAAAAAAAA", "src/service.ts");
  const second = finding("CT-BBBBBBBBBBBB", "src/service.ts", {
    expectationId: "source-debt-marker",
    severity: "info",
    requirement: { kind: "signal", key: "todo", description: "review TODO" },
    verification: [],
  });

  const candidates = planRemediationCandidates([second, first]);

  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    kind: "implementation",
    priority: 10,
    findingIds: ["CT-AAAAAAAAAAAA", "CT-BBBBBBBBBBBB"],
    expectationIds: ["source-debt-marker", "source-test-reachability"],
    requiresAgent: true,
  });
  expect(candidates[0]?.verification).toEqual([["bun", "run", "test"]]);
});

test("marks fully scaffoldable subjects as deterministic without claiming automatic mutation", () => {
  const candidates = planRemediationCandidates([
    finding("CT-CCCCCCCCCCCC", "src/widget.ts", {
      scaffold: {
        kind: "create-file",
        path: "src/widget.test.ts",
        content: "export {};\n",
      },
    }),
  ]);

  expect(candidates[0]).toMatchObject({
    kind: "deterministic-scaffold",
    requiresAgent: false,
    scaffolds: [
      {
        findingId: "CT-CCCCCCCCCCCC",
        path: "src/widget.test.ts",
        command: ["coding-tooling", "scaffold", "CT-CCCCCCCCCCCC"],
      },
    ],
  });
});

test("excludes suppressed, verified, and baseline findings by default", () => {
  const candidates = planRemediationCandidates([
    finding("CT-DDDDDDDDDDDD", "src/new.ts"),
    finding("CT-EEEEEEEEEEEE", "src/suppressed.ts", { disposition: "suppressed" }),
    finding("CT-FFFFFFFFFFFF", "src/verified.ts", { disposition: "verified" }),
    finding("CT-111111111111", "src/baseline.ts", { state: "baseline" }),
  ]);

  expect(candidates.map((candidate) => candidate.subject.key)).toEqual(["src/new.ts"]);
});

test("baseline debt is opt-in and sorts after equally severe new work", () => {
  const candidates = planRemediationCandidates(
    [
      finding("CT-222222222222", "src/baseline.ts", { state: "baseline", severity: "error" }),
      finding("CT-333333333333", "src/new.ts", { severity: "error" }),
    ],
    { includeBaseline: true },
  );

  expect(candidates.map((candidate) => candidate.subject.key)).toEqual([
    "src/new.ts",
    "src/baseline.ts",
  ]);
  expect(candidates.map((candidate) => candidate.priority)).toEqual([0, 50]);
});

test("candidate identity and ordering are stable across finding input order", () => {
  const first = finding("CT-444444444444", "src/stable.ts", {
    severity: "error",
    relatedFiles: ["src/z.ts", "src/a.ts"],
  });
  const second = finding("CT-555555555555", "src/stable.ts", {
    severity: "warning",
    verification: [["bun", "run", "test"], ["bun", "run", "typecheck"]],
  });

  const left = planRemediationCandidates([first, second]);
  const right = planRemediationCandidates([second, first]);

  expect(left).toEqual(right);
  expect(left[0]?.id).toMatch(/^CT-RM-[A-F0-9]{12}$/);
  expect(left[0]?.relatedFiles).toEqual(["src/a.ts", "src/stable.ts", "src/z.ts"]);
  expect(left[0]?.suggestedBranch).toMatch(/^remediate\/src-stable-ts-[a-f0-9]{6}$/);
});
