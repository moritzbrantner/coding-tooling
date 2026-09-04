import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { fleetMergeReadiness } from "../src/merge-readiness.ts";
import type { CommandResult } from "../src/shared.ts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fixture(merge?: Record<string, unknown>): { fleet: string; root: string } {
  const fleet = mkdtempSync(join(tmpdir(), "coding-tooling-merge-readiness-"));
  const root = join(fleet, "fixture");
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
    ...(merge ? { merge } : {}),
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
  return { fleet, root };
}

function result(status: number, stdout = "", stderr = ""): CommandResult {
  return { command: [], status, stdout, stderr };
}

type RunnerOptions = {
  protected?: boolean;
  checks?: string[];
  failRemote?: boolean;
};

function runner(options: RunnerOptions = {}) {
  return (command: string, args: string[] = []): CommandResult => {
    if (command !== "gh") return result(127, "", "unexpected command");
    if (options.failRemote) {
      return result(1, "", "remote evidence unavailable");
    }
    if (args[0] === "repo") {
      return result(
        0,
        JSON.stringify({ defaultBranchRef: { name: "main" } }),
      );
    }
    if (args[0] === "api") {
      const checks = options.checks ?? [];
      return result(
        0,
        JSON.stringify({
          protected: options.protected ?? false,
          protection: {
            required_status_checks: {
              contexts: checks,
              checks: checks.map((context) => ({ context })),
            },
          },
        }),
      );
    }
    return result(1, "", `unexpected gh invocation: ${args.join(" ")}`);
  };
}

type ReadinessRepository = {
  readiness: string;
  blockers: Array<{ code?: string }>;
  evidence: Record<string, unknown>;
};

function onlyRepository(
  output: ReturnType<typeof fleetMergeReadiness>,
): ReadinessRepository {
  return (output.data.repositories as ReadinessRepository[])[0]!;
}

describe("fleet merge readiness", () => {
  test("fails closed when merge authority has not been declared", () => {
    const { fleet } = fixture();

    const output = fleetMergeReadiness(fleet, { run: runner() });
    const repository = onlyRepository(output);

    expect(repository.readiness).toBe("not-ready");
    expect(repository.blockers.map((blocker) => blocker.code)).toContain(
      "merge-authority-undeclared",
    );
  });

  test("keeps local-only source graphs on the stronger local integration path", () => {
    const { fleet, root } = fixture({
      authority: "hosted",
      requiredChecks: ["Validate"],
    });
    writeJson(join(root, ".coding-tooling.source-deps.json"), {
      schemaVersion: 2,
      cargo: { localOnly: true, patches: [] },
    });

    const output = fleetMergeReadiness(fleet, {
      run: runner({ protected: true, checks: ["Validate"] }),
    });
    const repository = onlyRepository(output);

    expect(repository.readiness).toBe("local-gated");
    expect(repository.blockers.map((blocker) => blocker.code)).toContain(
      "merge-hosted-authority-conflicts-with-local-source",
    );
  });

  test("requires verifiable branch protection and nonzero required checks", () => {
    const { fleet } = fixture({
      authority: "hosted",
      requiredChecks: ["Validate"],
    });

    const unprotected = onlyRepository(
      fleetMergeReadiness(fleet, {
        run: runner({ protected: false, checks: ["Validate"] }),
      }),
    );
    const zeroChecks = onlyRepository(
      fleetMergeReadiness(fleet, {
        run: runner({ protected: true, checks: [] }),
      }),
    );

    expect(unprotected.readiness).toBe("protection-required");
    expect(unprotected.blockers.map((blocker) => blocker.code)).toContain(
      "merge-target-branch-unprotected",
    );
    expect(zeroChecks.readiness).toBe("protection-required");
    expect(zeroChecks.blockers.map((blocker) => blocker.code)).toContain(
      "merge-required-checks-zero",
    );
  });

  test("graduates only when protected required checks cover the declared hosted gate", () => {
    const { fleet } = fixture({
      authority: "hosted",
      requiredChecks: ["Validate", "Pages"],
    });

    const incomplete = onlyRepository(
      fleetMergeReadiness(fleet, {
        run: runner({ protected: true, checks: ["Validate"] }),
      }),
    );
    const trusted = onlyRepository(
      fleetMergeReadiness(fleet, {
        run: runner({ protected: true, checks: ["Pages", "Validate"] }),
      }),
    );

    expect(incomplete.readiness).toBe("protection-required");
    expect(incomplete.blockers.map((blocker) => blocker.code)).toContain(
      "merge-required-checks-not-protected",
    );
    expect(trusted.readiness).toBe("trusted-auto-merge");
    expect(trusted.blockers).toEqual([]);
  });

  test("treats missing remote evidence as a blocker rather than success", () => {
    const { fleet } = fixture({
      authority: "hosted",
      requiredChecks: ["Validate"],
    });

    const repository = onlyRepository(
      fleetMergeReadiness(fleet, {
        run: runner({ failRemote: true }),
      }),
    );

    expect(repository.readiness).toBe("protection-required");
    expect(repository.blockers.map((blocker) => blocker.code)).toContain(
      "merge-remote-default-branch-unavailable",
    );
  });
});
