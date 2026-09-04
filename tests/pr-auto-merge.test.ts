import { expect, test } from "bun:test";

import { activatePullRequestAutoMerge } from "../src/pr-auto-merge.ts";
import { policySensitivePath } from "../src/pr-eligibility.ts";
import type { ResultEnvelope } from "../src/model.ts";
import type { CommandResult } from "../src/shared.ts";

const headSha = "1111111111111111111111111111111111111111";
const baseSha = "2222222222222222222222222222222222222222";

function commandResult(status = 0, stdout = "", stderr = ""): CommandResult {
  return { command: [], status, stdout, stderr };
}

function eligibleResult(
  overrides: Partial<ResultEnvelope<Record<string, unknown>>> = {},
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "pr",
    status: "passed",
    durationMs: 1,
    data: {
      eligible: true,
      receipt: {
        repository: "example/repo",
        prNumber: 42,
        headSha,
        baseRef: "main",
        baseSha,
        requiredChecks: ["Validate"],
      },
    },
    diagnostics: [],
    ...overrides,
  };
}

function runWithCalls(result = commandResult()) {
  const calls: string[][] = [];
  return {
    calls,
    run(command: string, args: string[] = []): CommandResult {
      calls.push([command, ...args]);
      return { ...result, command: [command, ...args] };
    },
  };
}

test("classifies the guarded auto-merge implementation as policy-sensitive", () => {
  expect(policySensitivePath("src/pr-auto-merge.ts")).toBe(true);
});

test("requires exact prior head and base receipts before collecting eligibility", () => {
  let collections = 0;
  const runner = runWithCalls();
  const missingHead = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedBaseSha: baseSha },
    {
      run: runner.run,
      collectEligibility: () => {
        collections += 1;
        return eligibleResult();
      },
    },
  );
  const missingBase = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedHeadSha: headSha },
    {
      run: runner.run,
      collectEligibility: () => {
        collections += 1;
        return eligibleResult();
      },
    },
  );

  expect(missingHead.status).toBe("error");
  expect(missingBase.status).toBe("error");
  expect(collections).toBe(0);
  expect(runner.calls).toEqual([]);
});

test("propagates stale or blocked eligibility without attempting mutation", () => {
  const runner = runWithCalls();
  const blocked = eligibleResult({
    status: "unavailable",
    data: { eligible: false, blockers: ["head-moved"] },
    diagnostics: [{ code: "head-moved", message: "head-moved" }],
  });
  const output = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedHeadSha: headSha, expectedBaseSha: baseSha },
    { run: runner.run, collectEligibility: () => blocked },
  );

  expect(output.status).toBe("unavailable");
  expect(output.data.activationRequested).toBe(false);
  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain("head-moved");
  expect(runner.calls).toEqual([]);
});

test("refuses a passed eligibility result without the exact matching receipt", () => {
  const runner = runWithCalls();
  const mismatched = eligibleResult({
    data: {
      eligible: true,
      receipt: {
        repository: "example/repo",
        prNumber: 42,
        headSha: "3333333333333333333333333333333333333333",
        baseRef: "main",
        baseSha,
        requiredChecks: ["Validate"],
      },
    },
  });
  const output = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedHeadSha: headSha, expectedBaseSha: baseSha },
    { run: runner.run, collectEligibility: () => mismatched },
  );

  expect(output.status).toBe("unavailable");
  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "eligibility-receipt-mismatch",
  );
  expect(runner.calls).toEqual([]);
});

test("dry run revalidates the receipt but never mutates GitHub state", () => {
  const runner = runWithCalls();
  const output = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedHeadSha: headSha, expectedBaseSha: baseSha, dryRun: true },
    { run: runner.run, collectEligibility: () => eligibleResult() },
  );

  expect(output.status).toBe("passed");
  expect(output.data.eligible).toBe(true);
  expect(output.data.activationRequested).toBe(false);
  expect(runner.calls).toEqual([]);
});

test("activates auto-merge only against the fresh exact head", () => {
  const runner = runWithCalls(commandResult(0, "accepted"));
  const output = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedHeadSha: headSha, expectedBaseSha: baseSha },
    { run: runner.run, collectEligibility: () => eligibleResult() },
  );

  expect(output.status).toBe("passed");
  expect(output.data.activationRequested).toBe(true);
  expect(runner.calls).toEqual([
    ["gh", "pr", "merge", "42", "--auto", "--squash", "--match-head-commit", headSha],
  ]);
  expect(runner.calls[0]).not.toContain("--admin");
});

test("reports GitHub mutation rejection without retry or bypass", () => {
  const runner = runWithCalls(commandResult(1, "", "merge rejected"));
  const output = activatePullRequestAutoMerge(
    "/repo",
    42,
    { expectedHeadSha: headSha, expectedBaseSha: baseSha, mergeMethod: "rebase" },
    { run: runner.run, collectEligibility: () => eligibleResult() },
  );

  expect(output.status).toBe("failed");
  expect(output.data.activationRequested).toBe(false);
  expect(output.diagnostics).toEqual([
    { code: "auto-merge-activation-failed", message: "merge rejected" },
  ]);
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]).toContain("--rebase");
  expect(runner.calls[0]).not.toContain("--admin");
});
