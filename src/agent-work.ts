import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { check } from "./core.ts";
import { expectedEnvironmentFingerprint } from "./environment-fingerprint.ts";
import { findingsCommand } from "./expectations.ts";
import type { Capability, Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { capabilities } from "./model.ts";
import { remediationPlanCommand } from "./remediation-plan.ts";
import { type CommandResult, runCommand } from "./shared.ts";

export const TASK_PACKET_VERSION = "coding-tooling/task-packet/v1" as const;
export const AGENT_VERIFICATION_VERSION = "coding-tooling/agent-verification/v1" as const;
export const AGENT_HANDOFF_VERSION = "coding-tooling/agent-handoff/v1" as const;

export const changeKinds = [
  "behavior",
  "refactor",
  "performance",
  "protocol",
  "persistence",
  "browser",
  "mobile",
  "dependency",
  "security",
  "replay",
  "documentation",
] as const;

export type ChangeKind = (typeof changeKinds)[number];

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export type TaskPacket = {
  schemaVersion: typeof TASK_PACKET_VERSION;
  goal: string;
  baselineSha: string;
  ownedCapability: string;
  mustPreserve: string[];
  outOfScope: string[];
  changeKinds: ChangeKind[];
  acceptance?: {
    requiredCapabilities?: Capability[];
    evidence?: string[];
  };
  integrationCondition?: string;
};

export type EvidencePlan = {
  requiredCapabilities: Capability[];
  requiredEvidence: string[];
};

type PacketRead = {
  packet?: TaskPacket;
  digest?: string;
  diagnostics: Diagnostic[];
};

type VerificationReport = ResultEnvelope<Record<string, unknown>> & {
  operation: "agent-verification";
};

const kindEvidence: Record<ChangeKind, EvidencePlan> = {
  behavior: {
    requiredCapabilities: ["test"],
    requiredEvidence: ["behavior-regression"],
  },
  refactor: {
    requiredCapabilities: ["test"],
    requiredEvidence: ["behavior-parity"],
  },
  performance: {
    requiredCapabilities: ["benchmark:smoke"],
    requiredEvidence: ["equivalent-workload-benchmark", "versioned-or-declared-baseline"],
  },
  protocol: {
    requiredCapabilities: ["test:integration"],
    requiredEvidence: ["protocol-compatibility"],
  },
  persistence: {
    requiredCapabilities: ["test:integration"],
    requiredEvidence: ["persistence-boundary"],
  },
  browser: {
    requiredCapabilities: ["test:e2e:smoke"],
    requiredEvidence: ["representative-browser-journey"],
  },
  mobile: {
    requiredCapabilities: ["test"],
    requiredEvidence: ["representative-mobile-runtime"],
  },
  dependency: {
    requiredCapabilities: ["dependencies:audit"],
    requiredEvidence: ["dependency-resolution"],
  },
  security: {
    requiredCapabilities: ["test:integration"],
    requiredEvidence: ["security-boundary"],
  },
  replay: {
    requiredCapabilities: ["test"],
    requiredEvidence: ["deterministic-replay"],
  },
  documentation: {
    requiredCapabilities: [],
    requiredEvidence: ["claim-matches-verified-capability"],
  },
};

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return undefined;
  }
  return uniqueSorted(value.map((entry) => entry.trim()));
}

export function evidenceForChangeKinds(
  kinds: ChangeKind[],
  explicitCapabilities: Capability[] = [],
  explicitEvidence: string[] = [],
): EvidencePlan {
  return {
    requiredCapabilities: uniqueSorted([
      ...kinds.flatMap((kind) => kindEvidence[kind].requiredCapabilities),
      ...explicitCapabilities,
    ]),
    requiredEvidence: uniqueSorted([
      ...kinds.flatMap((kind) => kindEvidence[kind].requiredEvidence),
      ...explicitEvidence,
    ]),
  };
}

export function normalizeTaskPacket(value: unknown): PacketRead {
  const diagnostics: Diagnostic[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      diagnostics: [{ code: "task-packet-invalid", message: "Task packet must be a JSON object" }],
    };
  }
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== TASK_PACKET_VERSION) {
    diagnostics.push({
      code: "task-packet-schema-invalid",
      message: `schemaVersion must be ${TASK_PACKET_VERSION}`,
    });
  }
  const goal = typeof source.goal === "string" ? source.goal.trim() : "";
  const ownedCapability =
    typeof source.ownedCapability === "string" ? source.ownedCapability.trim() : "";
  if (!goal) diagnostics.push({ code: "task-packet-goal-missing", message: "goal is required" });
  if (!ownedCapability) {
    diagnostics.push({
      code: "task-packet-capability-missing",
      message: "ownedCapability is required",
    });
  }
  if (!isSha(source.baselineSha)) {
    diagnostics.push({
      code: "task-packet-baseline-invalid",
      message: "baselineSha must be an exact 40-character Git commit SHA",
    });
  }
  const mustPreserve = stringArray(source.mustPreserve);
  const outOfScope = stringArray(source.outOfScope);
  if (!mustPreserve) {
    diagnostics.push({
      code: "task-packet-preservation-invalid",
      message: "mustPreserve must be an array of non-empty strings",
    });
  }
  if (!outOfScope) {
    diagnostics.push({
      code: "task-packet-scope-invalid",
      message: "outOfScope must be an array of non-empty strings",
    });
  }
  const rawKinds = stringArray(source.changeKinds);
  const kinds = rawKinds?.filter((kind): kind is ChangeKind =>
    changeKinds.includes(kind as ChangeKind),
  );
  if (!rawKinds || !kinds || kinds.length !== rawKinds.length || kinds.length === 0) {
    diagnostics.push({
      code: "task-packet-change-kinds-invalid",
      message: `changeKinds must contain one or more of: ${changeKinds.join(", ")}`,
    });
  }

  let requiredCapabilities: Capability[] = [];
  let acceptanceEvidence: string[] = [];
  if (source.acceptance !== undefined) {
    if (
      !source.acceptance ||
      typeof source.acceptance !== "object" ||
      Array.isArray(source.acceptance)
    ) {
      diagnostics.push({
        code: "task-packet-acceptance-invalid",
        message: "acceptance must be an object when supplied",
      });
    } else {
      const acceptance = source.acceptance as Record<string, unknown>;
      if (acceptance.requiredCapabilities !== undefined) {
        const rawCapabilities = stringArray(acceptance.requiredCapabilities);
        if (
          !rawCapabilities ||
          rawCapabilities.some((capability) => !capabilities.includes(capability as Capability))
        ) {
          diagnostics.push({
            code: "task-packet-capabilities-invalid",
            message: "acceptance.requiredCapabilities contains an unknown capability",
          });
        } else {
          requiredCapabilities = rawCapabilities as Capability[];
        }
      }
      if (acceptance.evidence !== undefined) {
        const evidence = stringArray(acceptance.evidence);
        if (!evidence) {
          diagnostics.push({
            code: "task-packet-evidence-invalid",
            message: "acceptance.evidence must contain non-empty strings",
          });
        } else acceptanceEvidence = evidence;
      }
    }
  }
  const integrationCondition =
    typeof source.integrationCondition === "string"
      ? source.integrationCondition.trim()
      : undefined;
  if (source.integrationCondition !== undefined && !integrationCondition) {
    diagnostics.push({
      code: "task-packet-integration-condition-invalid",
      message: "integrationCondition must be a non-empty string when supplied",
    });
  }
  if (
    diagnostics.length > 0 ||
    !isSha(source.baselineSha) ||
    !mustPreserve ||
    !outOfScope ||
    !kinds
  ) {
    return { diagnostics };
  }

  const packet: TaskPacket = {
    schemaVersion: TASK_PACKET_VERSION,
    goal,
    baselineSha: source.baselineSha.toLowerCase(),
    ownedCapability,
    mustPreserve,
    outOfScope,
    changeKinds: uniqueSorted(kinds),
  };
  if (requiredCapabilities.length > 0 || acceptanceEvidence.length > 0) {
    packet.acceptance = {};
    if (requiredCapabilities.length > 0)
      packet.acceptance.requiredCapabilities = requiredCapabilities;
    if (acceptanceEvidence.length > 0) packet.acceptance.evidence = acceptanceEvidence;
  }
  if (integrationCondition) packet.integrationCondition = integrationCondition;

  const digest = createHash("sha256").update(JSON.stringify(packet)).digest("hex");
  return { packet, digest, diagnostics: [] };
}

function readTaskPacket(root: string, packetPath: string): PacketRead {
  try {
    return normalizeTaskPacket(JSON.parse(readFileSync(resolve(root, packetPath), "utf8")));
  } catch (error) {
    return {
      diagnostics: [
        {
          code: "task-packet-read-failed",
          message: error instanceof Error ? error.message : String(error),
          path: packetPath,
        },
      ],
    };
  }
}

function envelope(
  operation: "agent-task-packet" | "agent-verification" | "agent-handoff",
  status: ResultStatus,
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

function gitSha(root: string, runner: Runner, ref = "HEAD"): string | undefined {
  const result = runner("git", ["rev-parse", ref], root);
  const value = result.status === 0 ? result.stdout.trim() : "";
  return isSha(value) ? value.toLowerCase() : undefined;
}

function cleanWorktree(root: string, runner: Runner): { clean?: boolean; diagnostic?: Diagnostic } {
  const result = runner("git", ["status", "--porcelain"], root);
  if (result.status !== 0) {
    return {
      diagnostic: {
        code: "git-status-failed",
        message: result.stderr.trim() || result.error || "Could not inspect Git worktree",
      },
    };
  }
  return { clean: result.stdout.trim().length === 0 };
}

export function taskPacketCommand(
  root: string,
  packetPath: string,
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const read = readTaskPacket(root, packetPath);
  if (!read.packet || !read.digest) {
    return envelope("agent-task-packet", "failed", started, { root, packetPath }, read.diagnostics);
  }
  const evidencePlan = evidenceForChangeKinds(
    read.packet.changeKinds,
    read.packet.acceptance?.requiredCapabilities ?? [],
    read.packet.acceptance?.evidence ?? [],
  );
  return envelope("agent-task-packet", "passed", started, {
    root,
    packetPath,
    packetDigest: read.digest,
    packet: read.packet,
    evidencePlan,
  });
}

export function agentVerificationCommand(
  root: string,
  packetPath: string,
  dependencies: { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const read = readTaskPacket(root, packetPath);
  if (!read.packet || !read.digest) {
    return envelope(
      "agent-verification",
      "failed",
      started,
      { root, packetPath },
      read.diagnostics,
    );
  }
  const worktree = cleanWorktree(root, runner);
  if (worktree.diagnostic) {
    return envelope("agent-verification", "error", started, { root, packetPath }, [
      worktree.diagnostic,
    ]);
  }
  if (!worktree.clean) {
    return envelope("agent-verification", "unavailable", started, { root, packetPath }, [
      {
        code: "verification-dirty-worktree",
        message: "Exact-head verification requires a clean worktree",
      },
    ]);
  }
  const candidateSha = gitSha(root, runner);
  if (!candidateSha) {
    return envelope("agent-verification", "error", started, { root, packetPath }, [
      { code: "verification-head-unavailable", message: "Could not resolve exact candidate HEAD" },
    ]);
  }
  const baselineExists = runner(
    "git",
    ["cat-file", "-e", `${read.packet.baselineSha}^{commit}`],
    root,
  );
  if (baselineExists.status !== 0) {
    return envelope(
      "agent-verification",
      "unavailable",
      started,
      { root, packetPath, candidateSha },
      [
        {
          code: "verification-baseline-unavailable",
          message: `Baseline ${read.packet.baselineSha} is not available in this checkout`,
        },
      ],
    );
  }
  const evidencePlan = evidenceForChangeKinds(
    read.packet.changeKinds,
    read.packet.acceptance?.requiredCapabilities ?? [],
    read.packet.acceptance?.evidence ?? [],
  );
  const results = evidencePlan.requiredCapabilities.map((capability) => ({
    capability,
    result: check(root, capability),
  }));
  const endingSha = gitSha(root, runner);
  if (endingSha !== candidateSha) {
    return envelope(
      "agent-verification",
      "unavailable",
      started,
      { root, packetPath, candidateSha, endingSha: endingSha ?? null, results },
      [
        {
          code: "verification-head-moved",
          message:
            "HEAD changed while verification was running; discard the stale evidence and rerun",
        },
      ],
    );
  }
  const endingWorktree = cleanWorktree(root, runner);
  if (endingWorktree.clean !== true) {
    return envelope(
      "agent-verification",
      "failed",
      started,
      { root, packetPath, candidateSha, results },
      [
        {
          code: "verification-mutated-worktree",
          message: "Verification changed the worktree; green evidence must be non-mutating",
        },
      ],
    );
  }
  const statuses = results.map((entry) => entry.result.status);
  const status: ResultStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("failed")
      ? "failed"
      : statuses.includes("unavailable")
        ? "unavailable"
        : "passed";
  const diagnostics = results.flatMap((entry) =>
    entry.result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: `${entry.capability}: ${diagnostic.message}`,
    })),
  );
  const environment = expectedEnvironmentFingerprint(root, "default");
  return envelope(
    "agent-verification",
    status,
    started,
    {
      schemaVersion: AGENT_VERIFICATION_VERSION,
      root,
      packetPath,
      packetDigest: read.digest,
      baselineSha: read.packet.baselineSha,
      candidateSha,
      environment: {
        status: environment.status,
        data: environment.data,
        diagnostics: environment.diagnostics,
      },
      evidencePlan,
      results,
    },
    diagnostics,
  );
}

function readVerificationReport(
  root: string,
  path: string,
): {
  report?: VerificationReport;
  sha256?: string;
  diagnostic?: Diagnostic;
} {
  try {
    const content = readFileSync(resolve(root, path));
    const report = JSON.parse(content.toString("utf8")) as VerificationReport;
    if (report.schemaVersion !== 1 || report.operation !== "agent-verification") {
      return {
        diagnostic: {
          code: "verification-report-invalid",
          message: `${path} is not an agent-verification report`,
          path,
        },
      };
    }
    return {
      report,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "verification-report-read-failed",
        message: error instanceof Error ? error.message : String(error),
        path,
      },
    };
  }
}

export function agentHandoffCommand(
  root: string,
  packetPath: string,
  verificationReportPath: string,
  dependencies: { run?: Runner } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const runner = dependencies.run ?? runCommand;
  const read = readTaskPacket(root, packetPath);
  if (!read.packet || !read.digest) {
    return envelope("agent-handoff", "failed", started, { root, packetPath }, read.diagnostics);
  }
  const candidateSha = gitSha(root, runner);
  const worktree = cleanWorktree(root, runner);
  if (!candidateSha || worktree.clean !== true) {
    return envelope("agent-handoff", "unavailable", started, { root, packetPath }, [
      {
        code: "handoff-candidate-not-stable",
        message: "Handoff requires a clean worktree at an exact Git HEAD",
      },
    ]);
  }
  const verification = readVerificationReport(root, verificationReportPath);
  if (!verification.report || !verification.sha256) {
    return envelope("agent-handoff", "failed", started, { root, packetPath, candidateSha }, [
      verification.diagnostic ?? {
        code: "verification-report-invalid",
        message: "Verification report is invalid",
      },
    ]);
  }
  const reportCandidate = verification.report.data.candidateSha;
  const reportPacketDigest = verification.report.data.packetDigest;
  const verificationExact =
    verification.report.status === "passed" &&
    reportCandidate === candidateSha &&
    reportPacketDigest === read.digest;
  if (!verificationExact) {
    return envelope(
      "agent-handoff",
      "unavailable",
      started,
      {
        root,
        packetPath,
        candidateSha,
        verificationReportPath,
        verificationStatus: verification.report.status,
        verificationCandidateSha: reportCandidate ?? null,
      },
      [
        {
          code: "handoff-verification-stale",
          message:
            "Handoff verification must be passed and bound to the current candidate SHA and task-packet digest",
        },
      ],
    );
  }
  const baselineExists = runner(
    "git",
    ["cat-file", "-e", `${read.packet.baselineSha}^{commit}`],
    root,
  );
  if (baselineExists.status !== 0) {
    return envelope("agent-handoff", "unavailable", started, { root, packetPath, candidateSha }, [
      {
        code: "handoff-baseline-unavailable",
        message: `Baseline ${read.packet.baselineSha} is not available in this checkout`,
      },
    ]);
  }
  const diff = runner(
    "git",
    ["diff", "--name-only", `${read.packet.baselineSha}...${candidateSha}`],
    root,
  );
  if (diff.status !== 0) {
    return envelope("agent-handoff", "error", started, { root, packetPath, candidateSha }, [
      {
        code: "handoff-diff-failed",
        message: diff.stderr.trim() || diff.error || "Could not enumerate candidate changes",
      },
    ]);
  }
  const branch = runner("git", ["branch", "--show-current"], root);
  const findings = findingsCommand(root, { includeSuppressed: false });
  const unresolvedFindings = Array.isArray(findings.data.findings)
    ? (findings.data.findings as Array<Record<string, unknown>>).filter(
        (finding) => finding.disposition === "active",
      )
    : [];
  const remediation = remediationPlanCommand(root);
  const candidates = Array.isArray(remediation.data.candidates)
    ? (remediation.data.candidates as Array<Record<string, unknown>>)
    : [];
  const strongestNextAction =
    candidates.length > 0
      ? {
          kind: "remediation",
          candidate: candidates[0],
        }
      : {
          kind: "integration-review",
          condition:
            read.packet.integrationCondition ?? "review exact-head evidence before integration",
        };
  const verificationSummary = {
    path: verificationReportPath,
    sha256: verification.sha256,
    status: verification.report.status,
    candidateSha,
    packetDigest: read.digest,
  };

  return envelope("agent-handoff", "passed", started, {
    schemaVersion: AGENT_HANDOFF_VERSION,
    root,
    task: read.packet,
    packetDigest: read.digest,
    baselineSha: read.packet.baselineSha,
    candidateSha,
    branch: branch.status === 0 ? branch.stdout.trim() || null : null,
    changedFiles: diff.stdout.split(/\r?\n/).filter(Boolean).sort(),
    verification: verificationSummary,
    environment: verification.report.data.environment ?? null,
    unresolvedFindings,
    strongestNextAction,
  });
}
