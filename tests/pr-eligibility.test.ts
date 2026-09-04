import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  changesIntegrationPolicy,
  pullRequestMergeEligibility,
} from "../src/pr-eligibility.ts";
import type { CommandResult } from "../src/shared.ts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-pr-eligibility-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".repository.toml"),
    `schema_version = 1
id = "moritzbrantner/fixture"
kind = "library"
status = "active"
depends_on = []
consumed_by = []
supersedes = []
replaced_by = []
`,
  );
  writeJson(join(root, "package.json"), {
    name: "fixture",
    packageManager: "bun@1.4.0",
    scripts: { lint: "node -e process.exit(0)" },
  });
  writeFileSync(join(root, "bun.lock"), "fixture\n");
  writeFileSync(
    join(root, ".repository-environment.toml"),
    'schema_version = 1\ntrack = "latest-stable"\n',
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "codex-environment.sh"),
    '#!/usr/bin/env bash\ncase "${1:-}" in\n  "setup") ;;\n  "maintenance") ;;\nesac\n',
  );
  writeJson(join(root, ".coding-tooling.json"), {
    schemaVersion: 1,
    profile: "repository-foundation-v1",
    requiredCapabilities: ["lint"],
    capabilityCommands: {
      ".": {
        lint: ["node", "-e", "process.exit(0)"],
      },
    },
    merge: {
      authority: "hosted",
      requiredChecks: ["Validate"],
    },
  });
  writeJson(join(root, "conventions.json"), {
    schemaVersion: 1,
    registry: "coding-agent-conventions",
    modules: ["base"],
  });
  mkdirSync(join(root, ".conventions"), { recursive: true });
  const index = "# Installed conventions\n";
  writeFileSync(join(root, ".conventions", "index.md"), index);
  writeJson(join(root, "conventions.lock.json"), {
    schemaVersion: 1,
    sourceRevision: "fixture-revision",
    requestedModules: ["base"],
    resolvedModules: ["base"],
    files: { "index.md": hash(index) },
  });
  writeJson(join(root, "renovate.json"), {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: ["github>moritzbrantner/coding-agent-conventions"],
  });
  return root;
}

function result(status: number, stdout = "", stderr = ""): CommandResult {
  return { command: [], status, stdout, stderr };
}

type RunnerOptions = {
  baseRefName?: string;
  baseRefOid?: string;
  headRefOid?: string;
  mergeable?: string;
  files?: Array<{ path: string }>;
  changedFiles?: number;
  reviewDecision?: string | null;
  unresolvedThreads?: number;
  checks?: Array<Record<string, unknown>>;
  state?: string;
  draft?: boolean;
};

function runner(options: RunnerOptions = {}) {
  return (command: string, args: string[] = []): CommandResult => {
    if (command !== "gh") return result(127, "", "unexpected command");
    if (args[0] === "repo") {
      return result(0, JSON.stringify({ defaultBranchRef: { name: "main" } }));
    }
    if (args[0] === "api" && args[1] !== "graphql") {
      return result(
        0,
        JSON.stringify({
          protected: true,
          protection: {
            required_status_checks: {
              contexts: ["Validate"],
              checks: [{ context: "Validate" }],
            },
          },
        }),
      );
    }
    if (args[0] === "pr" && args[1] === "view") {
      const files = options.files ?? [{ path: "src/example.ts" }];
      return result(
        0,
        JSON.stringify({
          number: 7,
          state: options.state ?? "OPEN",
          isDraft: options.draft ?? false,
          mergeable: options.mergeable ?? "MERGEABLE",
          headRefOid: options.headRefOid ?? "head",
          baseRefOid: options.baseRefOid ?? "base",
          baseRefName: options.baseRefName ?? "main",
          reviewDecision: options.reviewDecision ?? null,
          statusCheckRollup:
            options.checks ??
            [
              {
                __typename: "CheckRun",
                name: "Validate",
                status: "COMPLETED",
                conclusion: "SUCCESS",
              },
            ],
          files,
          changedFiles: options.changedFiles ?? files.length,
          url: "https://github.com/moritzbrantner/fixture/pull/7",
        }),
      );
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const unresolved = options.unresolvedThreads ?? 0;
      return result(
        0,
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array.from({ length: unresolved }, () => ({ isResolved: false })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    }
    return result(1, "", `unexpected gh invocation: ${args.join(" ")}`);
  };
}

describe("integration policy path detection", () => {
  test("detects generic validation policy and coding-tooling integration changes", () => {
    expect(changesIntegrationPolicy("moritzbrantner/fixture", [".coding-tooling.json"])).toBe(
      true,
    );
    expect(
      changesIntegrationPolicy("moritzbrantner/fixture", [".github/workflows/validate.yml"]),
    ).toBe(true);
    expect(
      changesIntegrationPolicy("moritzbrantner/coding-tooling", ["src/pr-eligibility.ts"]),
    ).toBe(true);
    expect(changesIntegrationPolicy("moritzbrantner/fixture", ["src/domain.ts"])).toBe(false);
  });
});

describe("authenticated pull request eligibility collection", () => {
  test("collects a fully green exact-head candidate", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, {
      expectedHeadSha: "head",
      expectedBaseSha: "base",
      run: runner(),
    });

    expect(output.status).toBe("passed");
    expect(output.data.eligibility).toEqual({ eligible: true, blockers: [] });
  });

  test("fails closed when the evaluated head or base moved", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, {
      expectedHeadSha: "old-head",
      expectedBaseSha: "old-base",
      run: runner(),
    });
    const eligibility = output.data.eligibility as { eligible: boolean; blockers: string[] };

    expect(output.status).toBe("failed");
    expect(eligibility.blockers).toContain("head-moved");
    expect(eligibility.blockers).toContain("base-moved");
  });

  test("blocks non-default bases as stacked or otherwise unverified targets", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, {
      expectedHeadSha: "head",
      expectedBaseSha: "base",
      run: runner({ baseRefName: "feature-parent" }),
    });
    const eligibility = output.data.eligibility as { blockers: string[] };

    expect(eligibility.blockers).toContain("stack-dependency-blocked");
  });

  test("blocks unresolved review threads", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, {
      expectedHeadSha: "head",
      expectedBaseSha: "base",
      run: runner({ unresolvedThreads: 2 }),
    });
    const eligibility = output.data.eligibility as { blockers: string[] };

    expect(eligibility.blockers).toContain("blocking-review-threads");
  });

  test("cannot self-grant when integration policy changes", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, {
      expectedHeadSha: "head",
      expectedBaseSha: "base",
      run: runner({ files: [{ path: ".github/workflows/validate.yml" }] }),
    });
    const eligibility = output.data.eligibility as { blockers: string[] };

    expect(eligibility.blockers).toContain("integration-policy-change");
  });

  test("treats incomplete changed-file evidence as unavailable rather than safe", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, {
      expectedHeadSha: "head",
      expectedBaseSha: "base",
      run: runner({ files: [{ path: "src/domain.ts" }], changedFiles: 2 }),
    });
    const eligibility = output.data.eligibility as { blockers: string[] };

    expect(output.status).toBe("unavailable");
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "pr-changed-files-evidence-incomplete",
    );
    expect(eligibility.blockers).toContain("policy-change-evidence-missing");
  });

  test("fails closed when expected revision evidence is omitted", () => {
    const output = pullRequestMergeEligibility(fixture(), 7, { run: runner() });
    const eligibility = output.data.eligibility as { blockers: string[] };

    expect(eligibility.blockers).toContain("head-evidence-missing");
    expect(eligibility.blockers).toContain("base-evidence-missing");
  });
});
