import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openPullRequestReconciliation } from "../src/open-pr-reconciliation.ts";
import type { CommandResult } from "../src/shared.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-pr-reconcile-"));
  roots.push(root);
  writeFileSync(
    join(root, ".repository.toml"),
    [
      "schema_version = 1",
      'id = "owner/repository"',
      'kind = "library"',
      'status = "active"',
      "depends_on = []",
      "consumed_by = []",
      "supersedes = []",
      "replaced_by = []",
      "",
    ].join("\n"),
  );
  return root;
}

function result(stdout: unknown): CommandResult {
  return {
    command: [],
    status: 0,
    stdout: JSON.stringify(stdout),
    stderr: "",
  };
}

function runnerFor(
  openPullRequests: unknown[],
  mergedParents: Record<string, unknown[]> = {},
  unavailableMergedHeads = new Set<string>(),
) {
  return (command: string, args: string[] = []): CommandResult => {
    if (command === "gh" && args[0] === "repo") {
      return result({ defaultBranchRef: { name: "main" } });
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      const stateIndex = args.indexOf("--state");
      const state = stateIndex >= 0 ? args[stateIndex + 1] : undefined;
      if (state === "open") return result(openPullRequests);
      if (state === "merged") {
        const headIndex = args.indexOf("--head");
        const head = headIndex >= 0 ? args[headIndex + 1] : undefined;
        if (head && unavailableMergedHeads.has(head)) {
          return {
            command: [command, ...args],
            status: 1,
            stdout: "",
            stderr: "history unavailable",
          };
        }
        return result(head ? (mergedParents[head] ?? []) : []);
      }
    }
    return { command: [command, ...args], status: 1, stdout: "", stderr: "unexpected command" };
  };
}

describe("open pull-request reconciliation", () => {
  test("blocks a stacked pull request after its parent branch has already merged", () => {
    const root = fixture();
    const report = openPullRequestReconciliation(root, {
      run: runnerFor(
        [
          {
            number: 89,
            title: "remove scalar offsets",
            baseRefName: "a2-finish-span-consumers",
            headRefName: "a2-remove-scalar-span-fields",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
        ],
        {
          "a2-finish-span-consumers": [
            {
              number: 88,
              headRefName: "a2-finish-span-consumers",
              mergedAt: "2026-09-10T10:56:09Z",
            },
          ],
        },
      ),
    });

    expect(report.status).toBe("failed");
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "pr-reconciliation-merged-stack-base",
    );
    expect(report.data.summary).toMatchObject({ needsReconciliation: 1 });
  });

  test("accepts an active stack when an open parent pull request owns the child base branch", () => {
    const root = fixture();
    const report = openPullRequestReconciliation(root, {
      run: runnerFor([
        {
          number: 10,
          title: "parent",
          baseRefName: "main",
          headRefName: "feature-parent",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        },
        {
          number: 11,
          title: "child",
          baseRefName: "feature-parent",
          headRefName: "feature-child",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        },
      ]),
    });

    expect(report.status).toBe("passed");
    expect(report.data.summary).toMatchObject({ clean: 2, needsReconciliation: 0 });
  });

  test("keeps a legitimate non-default base advisory when it is not a merged stack parent", () => {
    const root = fixture();
    const report = openPullRequestReconciliation(root, {
      run: runnerFor([
        {
          number: 12,
          title: "release candidate",
          baseRefName: "staging",
          headRefName: "release-candidate",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        },
      ]),
    });

    expect(report.status).toBe("passed");
    expect(report.data.summary).toMatchObject({ refreshRecommended: 1, needsReconciliation: 0 });
  });

  test("fails closed when stack history cannot be queried", () => {
    const root = fixture();
    const report = openPullRequestReconciliation(root, {
      run: runnerFor(
        [
          {
            number: 13,
            title: "unknown stack",
            baseRefName: "former-parent",
            headRefName: "child",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
        ],
        {},
        new Set(["former-parent"]),
      ),
    });

    expect(report.status).toBe("failed");
    expect(report.diagnostics).toContainEqual({
      code: "pr-reconciliation-stack-history-unavailable",
      message: "history unavailable",
    });
  });

  test("blocks conflicting open branches but treats merely behind branches as refresh advice", () => {
    const root = fixture();
    const conflicting = openPullRequestReconciliation(root, {
      run: runnerFor([
        {
          number: 20,
          title: "conflicting",
          baseRefName: "main",
          headRefName: "conflicting-head",
          isDraft: false,
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        },
      ]),
    });
    expect(conflicting.status).toBe("failed");

    const behind = openPullRequestReconciliation(root, {
      run: runnerFor([
        {
          number: 21,
          title: "behind",
          baseRefName: "main",
          headRefName: "behind-head",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        },
      ]),
    });
    expect(behind.status).toBe("passed");
    expect(behind.data.summary).toMatchObject({ refreshRecommended: 1, needsReconciliation: 0 });
  });
});
