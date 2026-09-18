import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { findingCommand } from "../src/expectations.ts";
import { verifyFinding } from "../src/finding-verification.ts";
import { analyzeExpectations } from "../src/expectations.ts";
import { runCommand } from "../src/shared.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = runCommand("git", args, root);
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function fixture(verifierSource: string): { root: string; findingId: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-finding-verification-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".artifacts/\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          test: "bun test",
          "verify:service": "bun scripts/verify-service.ts",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
  writeFileSync(join(root, "scripts", "verify-service.ts"), verifierSource);

  const finding = analyzeExpectations(root).findings.find(
    (item) =>
      item.expectationId === "typescript-source-test" && item.subject.key === "src/service.ts",
  );
  expect(finding).toBeDefined();

  writeFileSync(
    join(root, ".coding-tooling.expectations.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        verifications: [
          {
            id: "VERIFY-SERVICE",
            version: 1,
            expectation: "typescript-source-test",
            subject: "src/service.ts",
            command: ["bun", "run", "verify:service"],
            reason: "repository-owned service verifier",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  git(root, "init");
  git(root, "config", "user.email", "coding-tooling@example.invalid");
  git(root, "config", "user.name", "coding-tooling");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return { root, findingId: finding!.id, head: git(root, "rev-parse", "HEAD").toLowerCase() };
}

describe("execution-backed finding verification", () => {
  test("promotes a declared verifier only after an exact-head passing execution", () => {
    const { root, findingId, head } = fixture("process.exit(0);\n");

    const result = verifyFinding(root, findingId);

    expect(result.status).toBe("passed");
    expect(result.data).toMatchObject({
      id: findingId,
      candidateSha: head,
      result: "verified",
      artifactPath: `.artifacts/coding-tooling/finding-verification/${findingId}.json`,
      receipt: {
        findingId,
        verificationId: "VERIFY-SERVICE",
        candidateSha: head,
        component: ".",
        command: ["bun", "run", "verify:service"],
        outcome: "passed",
        exitCode: 0,
      },
    });

    expect(findingCommand(root, findingId).data.finding).toMatchObject({
      id: findingId,
      disposition: "verified",
      verificationEvidence: {
        id: "VERIFY-SERVICE",
        candidateSha: head,
        component: ".",
        runner: { name: "bun" },
        artifactPath: `.artifacts/coding-tooling/finding-verification/${findingId}.json`,
      },
    });
  });

  test("keeps a finding active when its declared verifier fails", () => {
    const { root, findingId } = fixture("process.exit(7);\n");

    const result = verifyFinding(root, findingId);

    expect(result.status).toBe("failed");
    expect(result.data).toMatchObject({
      id: findingId,
      receipt: { outcome: "failed", exitCode: 7 },
    });
    expect(findingCommand(root, findingId).data.finding).toMatchObject({
      id: findingId,
      disposition: "active",
    });
  });

  test("does not reuse a passing receipt after HEAD advances", () => {
    const { root, findingId } = fixture("process.exit(0);\n");
    expect(verifyFinding(root, findingId).status).toBe("passed");

    writeFileSync(join(root, "README.md"), "# changed revision\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "advance head");

    expect(findingCommand(root, findingId).data.finding).toMatchObject({
      id: findingId,
      disposition: "active",
    });
  });

  test("refuses to execute a verifier from a dirty source worktree", () => {
    const { root, findingId } = fixture("process.exit(0);\n");
    writeFileSync(join(root, "src", "service.ts"), "export const service = false;\n");

    const result = verifyFinding(root, findingId);

    expect(result.status).toBe("unavailable");
    expect(result.diagnostics[0]?.code).toBe("verification-dirty-worktree");
    expect(findingCommand(root, findingId).data.finding).toMatchObject({
      id: findingId,
      disposition: "active",
    });
  });

  test("rejects a passing verifier that mutates repository source", () => {
    const { root, findingId } = fixture(
      'await Bun.write("src/service.ts", "export const service = false;\\n");\n',
    );

    const result = verifyFinding(root, findingId);

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("verification-source-mutated");
    expect(result.data).toMatchObject({
      receipt: { outcome: "invalid", exitCode: 0 },
    });
  });
});
