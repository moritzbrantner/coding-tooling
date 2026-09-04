import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repositoryEvidenceCommand } from "../src/repository-evidence.ts";
import type { ResultEnvelope } from "../src/model.ts";
import type { CommandResult } from "../src/shared.ts";

const revision = "1111111111111111111111111111111111111111";
const otherRevision = "2222222222222222222222222222222222222222";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "coding-tooling-repository-evidence-"));
}

function runner(command: string, args: string[] = []): CommandResult {
  if (command === "git" && args.join(" ") === "rev-parse HEAD") {
    return { command: [command, ...args], status: 0, stdout: `${revision}\n`, stderr: "" };
  }
  return { command: [command, ...args], status: 1, stdout: "", stderr: "unexpected command" };
}

function foundation(status: "passed" | "failed" = "passed"): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "foundation",
    status,
    durationMs: 1,
    data: {
      summary: { adopted: status === "passed" ? 5 : 4, missing: status === "passed" ? 0 : 1, invalid: 0, unsupported: 0 },
      components: { environment: { status: status === "passed" ? "adopted" : "missing" } },
    },
    diagnostics: status === "passed" ? [] : [{ code: "missing", message: "missing" }],
  };
}

const metadata = () => ({
  metadata: {
    schemaVersion: 1 as const,
    id: "example/repo",
    kind: "library" as const,
    status: "active" as const,
    dependsOn: [],
    consumedBy: [],
    supersedes: [],
    replacedBy: [],
  },
  diagnostics: [],
});

function readiness(value: "trusted-auto-merge" | "not-ready" = "trusted-auto-merge") {
  return {
    name: "repo",
    root: "/repo",
    repository: "example/repo",
    readiness: value,
    blockers: value === "trusted-auto-merge" ? [] : [{ code: "blocked", message: "blocked" }],
    evidence: {
      foundationStatus: value === "trusted-auto-merge" ? ("passed" as const) : ("failed" as const),
      mergeAuthority: "hosted" as const,
      mergeReason: null,
      requiredChecks: ["Validate"],
      localOnlySourceGraph: false,
      remote: null,
    },
  };
}

test("composes foundation and merge evidence without turning evidence health into a new threshold", () => {
  const root = fixture();
  try {
    const result = repositoryEvidenceCommand(
      root,
      {},
      {
        run: runner,
        readMetadata: metadata,
        collectFoundation: () => foundation("failed"),
        collectMergeReadiness: () => readiness("not-ready"),
      },
    );

    expect(result.status).toBe("passed");
    const evidence = result.data.evidence as Record<string, any>;
    expect(evidence.schemaVersion).toBe("coding-tooling/repository-evidence/v1");
    expect(evidence.repository.revision).toBe(revision);
    expect(evidence.sources.foundation.status).toBe("failed");
    expect(evidence.sources.merge.readiness).toBe("not-ready");
    expect(evidence.sources.validation.state).toBe("not-supplied");
    expect(evidence.sources.publicContract.state).toBe("not-supplied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarizes supplied validation and public-contract reports with immutable digests", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "validation.json"),
      JSON.stringify({
        schemaVersion: 1,
        operation: "run",
        status: "failed",
        data: {
          root,
          checks: [{}, {}, {}],
          results: [{ status: "passed" }, { status: "failed" }],
          missing: [{ optional: false }, { optional: true }],
        },
      }),
    );
    writeFileSync(
      join(root, "contract.json"),
      JSON.stringify({
        schemaVersion: 1,
        operation: "contract",
        status: "passed",
        data: {
          revision,
          enforcement: "observe",
          summary: {
            discovered: 4,
            verified: 3,
            unverified: 1,
            incompleteDiscovery: 0,
            failedEvidence: 0,
            unavailableEvidence: 0,
            errorEvidence: 0,
            verifiedRatio: 0.75,
            strictReady: false,
          },
        },
      }),
    );

    const result = repositoryEvidenceCommand(
      root,
      { validationReportPath: "validation.json", publicContractReportPath: "contract.json" },
      {
        run: runner,
        readMetadata: metadata,
        collectFoundation: () => foundation(),
        collectMergeReadiness: () => readiness(),
      },
    );

    expect(result.status).toBe("passed");
    const sources = (result.data.evidence as Record<string, any>).sources;
    expect(sources.validation).toMatchObject({
      state: "supplied",
      status: "failed",
      summary: {
        plannedChecks: 3,
        completedChecks: 2,
        passedChecks: 1,
        failedChecks: 1,
        blockedChecks: 1,
        missingRequiredCapabilities: 1,
      },
    });
    expect(sources.validation.report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sources.publicContract).toMatchObject({
      state: "supplied",
      status: "passed",
      revision,
      revisionMatchesCurrent: true,
      summary: { discovered: 4, verified: 3, unverified: 1, strictReady: false },
    });
    expect(sources.publicContract.report.sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a stale public-contract report instead of silently composing it", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "contract.json"),
      JSON.stringify({
        schemaVersion: 1,
        operation: "contract",
        status: "passed",
        data: {
          revision: otherRevision,
          enforcement: "observe",
          summary: {
            discovered: 1,
            verified: 1,
            unverified: 0,
            incompleteDiscovery: 0,
            failedEvidence: 0,
            unavailableEvidence: 0,
            errorEvidence: 0,
            verifiedRatio: 1,
            strictReady: true,
          },
        },
      }),
    );

    const result = repositoryEvidenceCommand(
      root,
      { publicContractReportPath: "contract.json" },
      {
        run: runner,
        readMetadata: metadata,
        collectFoundation: () => foundation(),
        collectMergeReadiness: () => readiness(),
      },
    );

    expect(result.status).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("repository-evidence-invalid-source");
    expect(result.diagnostics[0]?.message).toContain("not current revision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects validation evidence produced for another repository root", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "validation.json"),
      JSON.stringify({
        schemaVersion: 1,
        operation: "run",
        status: "passed",
        data: { root: "/different/repository", checks: [], results: [], missing: [] },
      }),
    );

    const result = repositoryEvidenceCommand(
      root,
      { validationReportPath: "validation.json" },
      {
        run: runner,
        readMetadata: metadata,
        collectFoundation: () => foundation(),
        collectMergeReadiness: () => readiness(),
      },
    );

    expect(result.status).toBe("error");
    expect(result.diagnostics[0]?.message).toContain("different repository root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
