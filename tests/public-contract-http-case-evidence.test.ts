import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";

import {
  publicContractCommand,
  type PublicContractReport,
  type PublicContractVerification,
} from "../src/public-contract.ts";
import type { TestCaseOutcome } from "../src/test-case-evidence.ts";

const roots: string[] = [];

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function git(root: string, ...args: string[]): void {
  gitOutput(root, ...args);
}

function fixture(options: {
  enforcement?: "observe" | "strict";
  verifications: PublicContractVerification[];
  emittedCases?: Array<{ id: string; outcome: TestCaseOutcome }>;
  mutateHead?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-http-case-"));
  roots.push(root);
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      exports: "./index.ts",
      scripts: { "test:integration": "bun test tests/contract.test.ts" },
    })}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "openapi.json"),
    `${JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/posts": { get: {}, post: {} },
      },
    })}\n`,
  );
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      contracts: {
        enforcement: options.enforcement ?? "observe",
        manifest: ".coding-tooling.contracts.json",
      },
    })}\n`,
  );
  writeFileSync(
    join(root, ".coding-tooling.contracts.json"),
    `${JSON.stringify({ schemaVersion: 1, verifications: options.verifications })}\n`,
  );
  writeFileSync(
    join(root, "case-outcomes.json"),
    `${JSON.stringify(options.emittedCases ?? [])}\n`,
  );
  const headMutation = options.mutateHead
    ? `
  writeFileSync("head-mutation.txt", "mutated\\n");
  const added = spawnSync("git", ["add", "head-mutation.txt"], { encoding: "utf8" });
  if (added.status !== 0) throw new Error(added.stderr || "git add failed");
  const committed = spawnSync("git", ["commit", "-qm", "mutate head"], { encoding: "utf8" });
  if (committed.status !== 0) throw new Error(committed.stderr || "git commit failed");
`
    : "";
  writeFileSync(
    join(root, "tests", "contract.test.ts"),
    `import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const evidencePath = process.env.CODING_TOOLING_CASE_EVIDENCE_PATH;

test("contract harness executes", () => {
  expect(true).toBe(true);
});

afterAll(() => {
  if (!evidencePath) return;
  const cases = JSON.parse(readFileSync("case-outcomes.json", "utf8"));
  writeFileSync(
    evidencePath,
    JSON.stringify({
      schemaVersion: 1,
      runId: process.env.CODING_TOOLING_CASE_EVIDENCE_RUN_ID,
      revision: process.env.CODING_TOOLING_CASE_EVIDENCE_REVISION,
      capability: process.env.CODING_TOOLING_CASE_EVIDENCE_CAPABILITY,
      component: process.env.CODING_TOOLING_CASE_EVIDENCE_COMPONENT,
      cases,
    }),
  );${headMutation}
});
`,
  );
  git(root, "init", "-q");
  git(root, "config", "user.name", "coding-tooling fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function report(root: string) {
  const result = publicContractCommand(root);
  return { result, report: result.data as unknown as PublicContractReport };
}

function getSurface(contract: PublicContractReport, id: string) {
  const surface = contract.surfaces.find((candidate) => candidate.id === id);
  if (!surface) throw new Error(`Missing surface ${id}`);
  return surface;
}

const getPosts = "http-operation:GET:%2Fposts";
const createPost = "http-operation:POST:%2Fposts";
const packageExport = "package-export:fixture:.";

function verification(
  id: string,
  surface: string,
  caseId?: string,
  behavior: "success" | "validation" = "success",
): PublicContractVerification {
  return {
    id,
    surface,
    kind: "behavioral",
    capability: "test:integration",
    ...(caseId ? { case: { id: caseId, behavior } } : {}),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("HTTP public contract case evidence", () => {
  test("does not let one passing suite verify an unmapped endpoint case", () => {
    const root = fixture({
      verifications: [
        verification("list-posts", getPosts, "posts-list-success"),
        verification("create-post", createPost, "posts-create-success"),
      ],
      emittedCases: [{ id: "posts-list-success", outcome: "passed" }],
    });

    const { result, report: contract } = report(root);
    const list = getSurface(contract, getPosts);
    const create = getSurface(contract, createPost);

    expect(result.status).toBe("passed");
    expect(list.status).toBe("verified");
    expect(list.evidence[0]).toMatchObject({
      capabilityOutcome: "passed",
      outcome: "passed",
      caseEvidence: { id: "posts-list-success", outcome: "passed" },
    });
    expect(create.status).toBe("unverified");
    expect(create.evidence[0]).toMatchObject({
      capabilityOutcome: "passed",
      outcome: "unavailable",
      caseEvidence: {
        id: "posts-create-success",
        outcome: "missing",
        reason: "test-case-evidence-case-missing",
      },
    });
  });

  test("does not treat broad HTTP capability evidence as an exact behavioral case", () => {
    const root = fixture({
      verifications: [verification("list-posts", getPosts)],
    });

    const { result, report: contract } = report(root);
    const list = getSurface(contract, getPosts);

    expect(result.status).toBe("passed");
    expect(list.status).toBe("unverified");
    expect(list.evidence[0]).toMatchObject({
      capabilityOutcome: "passed",
      outcome: "unavailable",
      caseEvidence: { outcome: "missing", reason: "http-case-declaration-missing" },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "public-contract-http-case-evidence-missing" }),
    );
  });

  test("keeps skipped and TODO exact cases unverified", () => {
    for (const outcome of ["skipped", "todo"] as const) {
      const root = fixture({
        verifications: [verification(`list-posts-${outcome}`, getPosts, "posts-list-success")],
        emittedCases: [{ id: "posts-list-success", outcome }],
      });
      const { report: contract } = report(root);
      const list = getSurface(contract, getPosts);

      expect(list.status).toBe("unverified");
      expect(list.evidence[0]).toMatchObject({
        capabilityOutcome: "passed",
        outcome: "unavailable",
        caseEvidence: { outcome, reason: `test-case-evidence-${outcome}` },
      });
    }
  });

  test("preserves broad capability verification for non-HTTP surfaces", () => {
    const root = fixture({
      verifications: [verification("package-export", packageExport)],
    });

    const { report: contract } = report(root);
    const exported = getSurface(contract, packageExport);

    expect(exported.status).toBe("verified");
    expect(exported.evidence[0]).toMatchObject({
      capabilityOutcome: "passed",
      outcome: "passed",
    });
    expect("caseEvidence" in exported.evidence[0]!).toBe(false);
  });

  test("keeps the report bound to the revision used by exact case evidence", () => {
    const root = fixture({
      verifications: [verification("list-posts", getPosts, "posts-list-success")],
      emittedCases: [{ id: "posts-list-success", outcome: "passed" }],
      mutateHead: true,
    });
    const verifiedRevision = gitOutput(root, "rev-parse", "HEAD");

    const { report: contract } = report(root);
    const mutatedRevision = gitOutput(root, "rev-parse", "HEAD");

    expect(mutatedRevision).not.toBe(verifiedRevision);
    expect(contract.revision).toBe(verifiedRevision);
    expect(getSurface(contract, getPosts).status).toBe("verified");
  });

  test("strict enforcement fails when exact HTTP case evidence is missing", () => {
    const root = fixture({
      enforcement: "strict",
      verifications: [verification("list-posts", getPosts)],
    });

    const { result, report: contract } = report(root);

    expect(result.status).toBe("failed");
    expect(getSurface(contract, getPosts).status).toBe("unverified");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "public-contract-not-strict-ready" }),
    );
  });
});
