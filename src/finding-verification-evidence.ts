import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Finding, FindingVerificationEvidence } from "./expectation-model.ts";
import { readJson, relativePosix, runCommand, type CommandResult } from "./shared.ts";
import { sourceRevision } from "./source-context.ts";

export const FINDING_VERIFICATION_RECEIPT_VERSION =
  "coding-tooling/finding-verification-receipt/v1" as const;

export type FindingVerificationReceiptOutcome = "passed" | "failed" | "error" | "invalid";

export type FindingVerificationReceipt = {
  schemaVersion: typeof FINDING_VERIFICATION_RECEIPT_VERSION;
  runId: string;
  findingId: string;
  verificationId: string;
  candidateSha: string;
  component: string;
  command: string[];
  runner: {
    name: string;
    version: string | null;
  };
  outcome: FindingVerificationReceiptOutcome;
  exitCode: number | null;
};

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function commandsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function findingVerificationReceiptPath(root: string, findingId: string): string {
  return join(root, ".artifacts", "coding-tooling", "finding-verification", `${findingId}.json`);
}

export function sourceWorktreeState(
  root: string,
  runner: Runner = runCommand,
): string[] | undefined {
  const result = runner("git", ["status", "--porcelain", "--untracked-files=all"], root);
  if (result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("?? .artifacts/coding-tooling/finding-verification/") &&
        !line.startsWith('?? ".artifacts/coding-tooling/finding-verification/'),
    )
    .sort();
}

export function writeFindingVerificationReceipt(
  root: string,
  receipt: FindingVerificationReceipt,
): string {
  const path = findingVerificationReceiptPath(root, receipt.findingId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return relativePosix(root, path);
}

export function readFindingVerificationReceipt(
  root: string,
  findingId: string,
): FindingVerificationReceipt | undefined {
  const path = findingVerificationReceiptPath(root, findingId);
  if (!existsSync(path)) return undefined;
  const value = readJson<unknown>(path);
  if (!isRecord(value) || value.schemaVersion !== FINDING_VERIFICATION_RECEIPT_VERSION) {
    return undefined;
  }
  if (
    typeof value.runId !== "string" ||
    !value.runId.trim() ||
    typeof value.findingId !== "string" ||
    typeof value.verificationId !== "string" ||
    !isSha(value.candidateSha) ||
    typeof value.component !== "string" ||
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    !value.command.every((part) => typeof part === "string" && part.length > 0) ||
    !isRecord(value.runner) ||
    typeof value.runner.name !== "string" ||
    (value.runner.version !== null && typeof value.runner.version !== "string") ||
    !["passed", "failed", "error", "invalid"].includes(String(value.outcome)) ||
    (value.exitCode !== null && !Number.isInteger(value.exitCode))
  ) {
    return undefined;
  }
  return value as FindingVerificationReceipt;
}

export function applyFindingVerificationEvidence(
  root: string,
  findings: Finding[],
  runner: Runner = runCommand,
): Finding[] {
  const withReceipts = findings.filter(
    (finding) =>
      finding.verificationDeclaration &&
      existsSync(findingVerificationReceiptPath(root, finding.id)),
  );
  if (withReceipts.length === 0) return findings;

  const candidateSha = sourceRevision(root, runner);
  const worktree = sourceWorktreeState(root, runner);
  if (!candidateSha || !worktree || worktree.length > 0) return findings;

  return findings.map((finding) => {
    const declaration = finding.verificationDeclaration;
    if (!declaration) return finding;
    const receipt = readFindingVerificationReceipt(root, finding.id);
    if (
      !receipt ||
      receipt.outcome !== "passed" ||
      receipt.findingId !== finding.id ||
      receipt.verificationId !== declaration.id ||
      receipt.candidateSha.toLowerCase() !== candidateSha ||
      receipt.component !== declaration.component ||
      !commandsEqual(receipt.command, declaration.command)
    ) {
      return finding;
    }

    const verificationEvidence: FindingVerificationEvidence = {
      id: declaration.id,
      version: declaration.version,
      command: [...declaration.command],
      reason: declaration.reason,
      candidateSha,
      runId: receipt.runId,
      component: declaration.component,
      runner: receipt.runner,
      artifactPath: relativePosix(root, findingVerificationReceiptPath(root, finding.id)),
    };
    return { ...finding, disposition: "verified", verificationEvidence };
  });
}
