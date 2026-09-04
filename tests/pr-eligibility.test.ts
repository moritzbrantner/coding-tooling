import { expect, test } from "bun:test";

import type { RepositoryMergeReadiness } from "../src/merge-readiness.ts";
import {
  declaredPullRequestDependencies,
  policySensitivePath,
  pullRequestMergeEligibility,
} from "../src/pr-eligibility.ts";
import type { CommandResult } from "../src/shared.ts";

const headSha = "1111111111111111111111111111111111111111";
const movedHeadSha = "2222222222222222222222222222222222222222";
const baseSha = "3333333333333333333333333333333333333333";
const movedBaseSha = "4444444444444444444444444444444444444444";

type FakeOptions = {
  checks?: Array<Record<string, unknown>>;
  files?: string[];
  body?: string;
  headSha?: string;
  baseSha?: string;
  state?: string;
  draft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  unresolvedThreads?: number;
  threadEvidenceComplete?: boolean;
  dependencyMerged?: Record<number, boolean>;
};

function result(stdout = "", status = 0, stderr = ""): CommandResult {
  return { command: [], status, stdout, stderr };
}

function trustedReadiness(): RepositoryMergeReadiness {
  return {
    name: "repo",
    root: "/repo",
    repository: "example/repo",
    readiness: "trusted-auto-merge",
    blockers: [],
    evidence: {
      foundationStatus: "passed",
      mergeAuthority: "hosted",
      mergeReason: null,
      requiredChecks: ["Validate"],
      localOnlySourceGraph: false,
      remote: {
        available: true,
        branch: "main",
        protected: true,
        requiredChecks: ["Validate"],
        diagnostics: [],
      },
    },
  };
}

function localGatedReadiness(): RepositoryMergeReadiness {
  return {
    ...trustedReadiness(),
    readiness: "local-gated",
    evidence: {
      ...trustedReadiness().evidence,
      mergeAuthority: "local",
      mergeReason: "hardware-bound validation is authoritative",
      localOnlySourceGraph: true,
      remote: null,
    },
  };
}

function successfulCheck(): Array<Record<string, unknown>> {
  return [
    {
      __typename: "CheckRun",
      name: "Validate",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
  ];
}

function fakeRunner(options: FakeOptions = {}) {
  const checks = options.checks ?? successfulCheck();
  const files = options.files ?? ["src/feature.ts"];
  const unresolvedThreads = options.unresolvedThreads ?? 0;
  const complete = options.threadEvidenceComplete ?? true;
  return (command: string, args: string[] = []): CommandResult => {
    if (command !== "gh") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);

    if (args[0] === "pr" && args[1] === "view" && args[2] === "42") {
      return result(
        JSON.stringify({
          number: 42,
          state: options.state ?? "OPEN",
          isDraft: options.draft ?? false,
          mergeable: options.mergeable ?? "MERGEABLE",
          mergeStateStatus: options.mergeStateStatus ?? "CLEAN",
          reviewDecision: options.reviewDecision ?? "APPROVED",
          headRefOid: options.headSha ?? headSha,
          baseRefName: "main",
          statusCheckRollup: checks,
          url: "https://github.com/example/repo/pull/42",
          body: options.body ?? "",
          files: files.map((path) => ({ path })),
        }),
      );
    }

    if (args[0] === "api" && args[1] === "repos/example/repo/branches/main") {
      return result(JSON.stringify({ commit: { sha: options.baseSha ?? baseSha } }));
    }

    if (args[0] === "api" && args[1] === "graphql") {
      return result(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array.from({ length: unresolvedThreads }, () => ({ isResolved: false })),
                  pageInfo: { hasNextPage: !complete },
                },
              },
            },
          },
        }),
      );
    }

    if (args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      const merged = options.dependencyMerged?.[number] ?? false;
      return result(
        JSON.stringify({
          number,
          state: merged ? "MERGED" : "OPEN",
          mergedAt: merged ? "2026-09-04T12:00:00Z" : null,
          url: `https://github.com/example/repo/pull/${number}`,
        }),
      );
    }

    throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
  };
}

function evaluate(
  options: FakeOptions = {},
  eligibilityOptions: { expectedHeadSha?: string; expectedBaseSha?: string } = {},
  readiness = trustedReadiness(),
) {
  return pullRequestMergeEligibility("/repo", 42, eligibilityOptions, {
    run: fakeRunner(options),
    readRepositoryReadiness: () => readiness,
  });
}

test("recognizes policy-sensitive merge and validation surfaces", () => {
  expect(policySensitivePath(".coding-tooling.json")).toBe(true);
  expect(policySensitivePath(".github/workflows/validate.yml")).toBe(true);
  expect(policySensitivePath("src/pr.ts")).toBe(true);
  expect(policySensitivePath("src/feature.ts")).toBe(false);
});

test("extracts explicit stacked pull-request dependencies deterministically", () => {
  expect(
    declaredPullRequestDependencies(
      `Depends on #12\n- Stacked on: #9 and #12\nAfter #7\nMention #99`,
    ),
  ).toEqual([7, 9, 12]);
});

test("returns an exact-head receipt for a trusted fully-green pull request", () => {
  const output = evaluate();

  expect(output.status).toBe("passed");
  expect(output.data.eligible).toBe(true);
  expect(output.data.receipt).toEqual({
    repository: "example/repo",
    prNumber: 42,
    headSha,
    baseRef: "main",
    baseSha,
    requiredChecks: ["Validate"],
  });
});

test("keeps local-gated repositories on the stronger integration path", () => {
  const output = evaluate({}, {}, localGatedReadiness());

  expect(output.status).toBe("unavailable");
  expect(output.data.eligible).toBe(false);
  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "repository-not-trusted-auto-merge",
  );
});

test("zero attached checks is never eligible", () => {
  const output = evaluate({ checks: [] });

  expect(output.status).toBe("unavailable");
  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain("pr-checks-zero");
  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "pr-required-checks-missing",
  );
});

test("pending and failed checks block unattended merge", () => {
  const pending = evaluate({
    checks: [
      {
        __typename: "CheckRun",
        name: "Validate",
        status: "IN_PROGRESS",
        conclusion: "",
      },
    ],
  });
  const failed = evaluate({
    checks: [
      {
        __typename: "CheckRun",
        name: "Validate",
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
    ],
  });

  expect(pending.diagnostics.map((diagnostic) => diagnostic.code)).toContain("pr-checks-pending");
  expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("pr-checks-failed");
});

test("policy-changing pull requests cannot self-grant unattended eligibility", () => {
  const output = evaluate({ files: ["src/feature.ts", ".github/workflows/validate.yml"] });

  expect(output.status).toBe("unavailable");
  expect(output.data.policySensitiveFiles).toEqual([".github/workflows/validate.yml"]);
  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "pr-changes-merge-policy",
  );
});

test("stale expected head and base receipts fail closed", () => {
  const movedHead = evaluate(
    { headSha: movedHeadSha },
    { expectedHeadSha: headSha, expectedBaseSha: baseSha },
  );
  const movedBase = evaluate(
    { baseSha: movedBaseSha },
    { expectedHeadSha: headSha, expectedBaseSha: baseSha },
  );

  expect(movedHead.diagnostics.map((diagnostic) => diagnostic.code)).toContain("pr-head-moved");
  expect(movedBase.diagnostics.map((diagnostic) => diagnostic.code)).toContain("pr-base-moved");
});

test("review decisions and unresolved review threads block unattended merge", () => {
  const requestedChanges = evaluate({ reviewDecision: "CHANGES_REQUESTED" });
  const unresolvedThread = evaluate({ unresolvedThreads: 1 });

  expect(requestedChanges.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "pr-review-blocker",
  );
  expect(unresolvedThread.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "pr-review-threads-unresolved",
  );
});

test("incomplete review-thread evidence fails closed", () => {
  const output = evaluate({ threadEvidenceComplete: false });

  expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "pr-review-thread-evidence-incomplete",
  );
});

test("declared stack dependencies must be merged before the pull request", () => {
  const blocked = evaluate({ body: "Depends on #41", dependencyMerged: { 41: false } });
  const resolved = evaluate({ body: "Depends on #41", dependencyMerged: { 41: true } });

  expect(blocked.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "pr-dependency-unresolved",
  );
  expect(resolved.status).toBe("passed");
  expect(resolved.data.eligible).toBe(true);
});
