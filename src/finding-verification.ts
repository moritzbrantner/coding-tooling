import { join } from "node:path";

import type { ExpectationEnvelope } from "./expectation-model.ts";
import { findingIdPattern } from "./expectation-model.ts";
import { analyzeExpectations, findingCommand } from "./expectations.ts";
import {
  exactHead,
  sourceWorktreeState,
  writeFindingVerificationReceipt,
  type FindingVerificationReceipt,
  type FindingVerificationReceiptOutcome,
} from "./finding-verification-evidence.ts";
import { runCommand, type CommandResult } from "./shared.ts";

type Runner = (
  command: string,
  args?: string[],
  cwd?: string,
  inherit?: boolean,
) => CommandResult;

export type FindingVerificationDependencies = {
  run?: Runner;
};

function envelope(
  status: ExpectationEnvelope["status"],
  started: number,
  data: Record<string, unknown>,
  diagnostics: ExpectationEnvelope["diagnostics"] = [],
): ExpectationEnvelope {
  return {
    schemaVersion: 1,
    operation: "finding-verify",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function verifyFinding(
  root: string,
  id: string,
  dependencies: FindingVerificationDependencies = {},
): ExpectationEnvelope {
  const started = Date.now();
  if (!findingIdPattern.test(id)) {
    return envelope("unavailable", started, { root, id }, [
      { code: "invalid-finding-id", message: `Invalid finding ID: ${id}` },
    ]);
  }

  const runner = dependencies.run ?? runCommand;
  const candidateSha = exactHead(root, runner);
  const initialWorktree = sourceWorktreeState(root, runner);
  if (!candidateSha || initialWorktree === undefined) {
    return envelope("unavailable", started, { root, id }, [
      {
        code: "verification-source-unavailable",
        message: "An exact Git HEAD and observable worktree are required for finding verification",
      },
    ]);
  }
  if (initialWorktree.length > 0) {
    return envelope("unavailable", started, { root, id, candidateSha, worktree: initialWorktree }, [
      {
        code: "verification-dirty-worktree",
        message: "Finding verification requires a clean source worktree",
      },
    ]);
  }

  const analysis = analyzeExpectations(root, {
    includeSuppressed: true,
    includeVerificationEvidence: false,
  });
  const finding = analysis.findings.find((item) => item.id === id);
  if (!finding || finding.disposition !== "active") {
    return envelope("unavailable", started, { root, id, candidateSha, finding }, [
      {
        code: "finding-not-active",
        message: `Finding ${id} must be active before its declared verifier can run`,
      },
    ]);
  }
  const declaration = finding.verificationDeclaration;
  if (!declaration) {
    return envelope("unavailable", started, { root, id, candidateSha, finding }, [
      {
        code: "verification-not-declared",
        message: `Finding ${id} has no repository-owned verification declaration`,
      },
    ]);
  }

  const cwd = declaration.component === "." ? root : join(root, declaration.component);
  const runnerVersionResult = runner(declaration.command[0]!, ["--version"], cwd);
  const version =
    runnerVersionResult.status === 0 && runnerVersionResult.stdout.trim()
      ? runnerVersionResult.stdout.trim().split(/\r?\n/)[0]!
      : null;
  const execution = runner(declaration.command[0]!, declaration.command.slice(1), cwd);

  const endingSha = exactHead(root, runner);
  const endingWorktree = sourceWorktreeState(root, runner);
  let outcome: FindingVerificationReceiptOutcome = execution.error
    ? "error"
    : execution.status === 0
      ? "passed"
      : "failed";
  if (endingSha !== candidateSha || endingWorktree === undefined || endingWorktree.length > 0) {
    outcome = "invalid";
  }

  const receipt: FindingVerificationReceipt = {
    schemaVersion: "coding-tooling/finding-verification-receipt/v1",
    findingId: id,
    verificationId: declaration.id,
    candidateSha,
    component: declaration.component,
    command: [...declaration.command],
    runner: {
      name: declaration.command[0]!,
      version,
    },
    outcome,
    exitCode: execution.error ? null : execution.status,
  };
  const artifactPath = writeFindingVerificationReceipt(root, receipt);

  if (outcome === "invalid") {
    return envelope("failed", started, { root, id, candidateSha, artifactPath, receipt }, [
      {
        code: "verification-source-mutated",
        message:
          "The declared verifier changed repository source state or HEAD; its result cannot verify the finding",
      },
    ]);
  }
  if (outcome !== "passed") {
    return envelope(outcome === "error" ? "error" : "failed", started, {
      root,
      id,
      candidateSha,
      artifactPath,
      receipt,
      stdout: execution.stdout,
      stderr: execution.stderr,
      error: execution.error,
    });
  }

  const updated = findingCommand(root, id);
  const updatedFinding = updated.data.finding;
  if (
    updated.status !== "passed" ||
    !updatedFinding ||
    typeof updatedFinding !== "object" ||
    (updatedFinding as { disposition?: string }).disposition !== "verified"
  ) {
    return envelope("failed", started, { root, id, candidateSha, artifactPath, receipt }, [
      {
        code: "verification-receipt-not-applied",
        message: "The verifier passed but its exact-revision receipt was not accepted",
      },
    ]);
  }

  return envelope("passed", started, {
    root,
    id,
    candidateSha,
    result: "verified",
    artifactPath,
    receipt,
    finding: updatedFinding,
  });
}
