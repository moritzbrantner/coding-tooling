import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { check, declaredComponents } from "./core.ts";
import {
  normalizeProductAcceptance,
  selectMergeVerification,
  validateProductReferences,
  type ProductAcceptance,
  type MergeVerificationDecision,
} from "./agent-product-evidence.ts";
import { expectedEnvironmentFingerprint } from "./environment-fingerprint.ts";
import { findingsCommand } from "./expectations.ts";
import { parseAuthorityBoundaries } from "./fleet-authority-graph.ts";
import type { Capability, Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { capabilities } from "./model.ts";
import { collectTestDiscoveryEvidence } from "./test-discovery-evidence.ts";
import { isTestCapability } from "./test-execution-evidence.ts";
import { remediationPlanCommand } from "./remediation-plan.ts";
import {
  forbiddenAuthorityClaims,
  type RepositoryArchitecture,
} from "./repository-contract-declarations.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { type CommandResult, runCommand } from "./shared.ts";
import { sourceRevision } from "./source-context.ts";

export const TASK_PACKET_VERSION = "coding-tooling/task-packet/v1" as const;
export const AGENT_VERIFICATION_VERSION = "coding-tooling/agent-verification/v1" as const;
export const AGENT_HANDOFF_VERSION = "coding-tooling/agent-handoff/v1" as const;

export const changeKinds = [
  "behavior",
  "architecture",
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
    reviewRequirements?: string[];
    product?: ProductAcceptance;
  };
  integrationCondition?: string;
};

export type EvidencePlan = {
  requiredCapabilities: Capability[];
  reviewRequirements: string[];
};

type PacketRead = {
  packet?: TaskPacket;
  digest?: string;
  diagnostics: Diagnostic[];
  repositoryBoundaries?: { purpose: string | null; architecture: RepositoryArchitecture | null };
};

type VerificationReport = ResultEnvelope<Record<string, unknown>> & {
  operation: "agent-verification";
};

const kindEvidence: Record<ChangeKind, EvidencePlan> = {
  architecture: {
    requiredCapabilities: ["test"],
    reviewRequirements: [],
  },
  behavior: {
    requiredCapabilities: ["test"],
    reviewRequirements: [],
  },
  refactor: {
    requiredCapabilities: ["test"],
    reviewRequirements: [],
  },
  performance: {
    requiredCapabilities: ["benchmark:smoke"],
    reviewRequirements: [],
  },
  protocol: {
    requiredCapabilities: ["test:integration"],
    reviewRequirements: [],
  },
  persistence: {
    requiredCapabilities: ["test:integration"],
    reviewRequirements: [],
  },
  browser: {
    requiredCapabilities: ["test:e2e:smoke"],
    reviewRequirements: [],
  },
  mobile: {
    requiredCapabilities: ["test"],
    reviewRequirements: [],
  },
  dependency: {
    requiredCapabilities: ["dependencies:audit"],
    reviewRequirements: [],
  },
  security: {
    requiredCapabilities: ["test:integration"],
    reviewRequirements: [],
  },
  replay: {
    requiredCapabilities: ["test"],
    reviewRequirements: [],
  },
  documentation: {
    requiredCapabilities: [],
    reviewRequirements: [],
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
  explicitReviewRequirements: string[] = [],
): EvidencePlan {
  return {
    requiredCapabilities: uniqueSorted([
      ...kinds.flatMap((kind) => kindEvidence[kind].requiredCapabilities),
      ...explicitCapabilities,
    ]),
    reviewRequirements: uniqueSorted([
      ...kinds.flatMap((kind) => kindEvidence[kind].reviewRequirements),
      ...explicitReviewRequirements,
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
  let reviewRequirements: string[] = [];
  let product: ProductAcceptance | undefined;
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
      if (acceptance.product !== undefined) {
        const parsed = normalizeProductAcceptance(acceptance.product);
        diagnostics.push(...parsed.diagnostics);
        product = parsed.product;
      }
      if (acceptance.reviewRequirements !== undefined) {
        const evidence = stringArray(acceptance.reviewRequirements);
        if (!evidence) {
          diagnostics.push({
            code: "task-packet-review-requirements-invalid",
            message: "acceptance.reviewRequirements must contain non-empty strings",
          });
        } else reviewRequirements = evidence;
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
  if (requiredCapabilities.length > 0 || reviewRequirements.length > 0 || product) {
    packet.acceptance = {};
    if (requiredCapabilities.length > 0)
      packet.acceptance.requiredCapabilities = requiredCapabilities;
    if (reviewRequirements.length > 0) packet.acceptance.reviewRequirements = reviewRequirements;
    if (product) packet.acceptance.product = product;
  }
  if (integrationCondition) packet.integrationCondition = integrationCondition;

  const digest = createHash("sha256").update(JSON.stringify(packet)).digest("hex");
  return { packet, digest, diagnostics: [] };
}

function packetEvidencePlan(packet: TaskPacket): EvidencePlan {
  const product = packet.acceptance?.product;
  return evidenceForChangeKinds(
    packet.changeKinds,
    [
      ...(packet.acceptance?.requiredCapabilities ?? []),
      ...(product?.coreSmokeCapabilities ?? []),
      ...(product?.contracts.map((contract) => contract.capability) ?? []),
    ],
    packet.acceptance?.reviewRequirements ?? [],
  );
}

function independenceFromPacket(packet: TaskPacket) {
  const claim = packet.acceptance?.product?.independentAgentClaim ?? null;
  return {
    claim,
    status: claim ? "claimed-unverified" : "not-claimed",
    machineVerified: false,
  };
}

function readTaskPacket(root: string, packetPath: string): PacketRead {
  try {
    const result = normalizeTaskPacket(JSON.parse(readFileSync(resolve(root, packetPath), "utf8")));
    if (!result.packet) return result;
    const metadata = existsSync(resolve(root, ".repository.toml"))
      ? readRepositoryMetadata(root)
      : undefined;
    if (metadata && !metadata.metadata) return { diagnostics: metadata.diagnostics };
    const agentsPath = resolve(root, "AGENTS.md");
    const authority = existsSync(agentsPath)
      ? parseAuthorityBoundaries(readFileSync(agentsPath, "utf8"))
      : undefined;
    const declared = metadata?.metadata?.architecture;
    const architecture =
      declared || authority
        ? {
            owns: declared?.owns ?? authority?.owns ?? [],
            consumes: declared?.consumes ?? authority?.adapts ?? [],
            mustNotOwn: uniqueSorted([
              ...(declared?.mustNotOwn ?? []),
              ...(authority?.nonAuthoritative ?? []),
            ]),
          }
        : null;
    const violations = architecture
      ? forbiddenAuthorityClaims(architecture, [result.packet.ownedCapability])
      : [];
    if (violations.length)
      return {
        diagnostics: violations.map((violation) => ({
          code: "task-packet-forbidden-repository-authority",
          message: `ownedCapability ${violation.capability} violates repository exclusion ${violation.exclusion}`,
          path: ".repository.toml",
        })),
      };
    return {
      ...result,
      repositoryBoundaries: { purpose: metadata?.metadata?.summary ?? null, architecture },
    };
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

function exactCheckout(root: string, sha: string, runner: Runner): boolean {
  const checkout = runner("git", ["rev-parse", "HEAD"], root);
  return checkout.status === 0 && checkout.stdout.trim().toLowerCase() === sha;
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
  const evidencePlan = packetEvidencePlan(read.packet);
  return envelope("agent-task-packet", "passed", started, {
    root,
    packetPath,
    packetDigest: read.digest,
    packet: read.packet,
    evidencePlan,
    repositoryBoundaries: read.repositoryBoundaries ?? null,
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
        message: "Source-bound verification requires a clean worktree",
      },
    ]);
  }
  const candidateSha = sourceRevision(root, runner);
  if (!candidateSha) {
    return envelope("agent-verification", "error", started, { root, packetPath }, [
      {
        code: "verification-head-unavailable",
        message: "Could not resolve the caller source revision or local Git fallback",
      },
    ]);
  }
  const product = read.packet.acceptance?.product;
  if (product && !exactCheckout(root, candidateSha, runner)) {
    return envelope(
      "agent-verification",
      "unavailable",
      started,
      { root, packetPath, candidateSha },
      [
        {
          code: "verification-source-revision-mismatch",
          message:
            "Product verification requires the checkout HEAD to equal the candidate revision",
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
  if (
    product &&
    runner("git", ["merge-base", "--is-ancestor", read.packet.baselineSha, candidateSha], root)
      .status !== 0
  ) {
    return envelope("agent-verification", "unavailable", started, { root, packetPath, candidateSha }, [
      {
        code: "verification-baseline-not-ancestor",
        message: "Product verification requires the baseline to be an ancestor of the candidate",
      },
    ]);
  }
  const evidencePlan = packetEvidencePlan(read.packet);
  const referenceDiagnostics = product
    ? validateProductReferences(root, product, candidateSha, runner)
    : [];
  if (referenceDiagnostics.length) {
    return envelope(
      "agent-verification",
      "unavailable",
      started,
      { root, packetPath, candidateSha, referenceValidation: "failed" },
      referenceDiagnostics,
    );
  }
  let mergeVerification: MergeVerificationDecision | null = null;
  if (product) {
    const diff = runner(
      "git",
      ["diff", "--name-only", `${read.packet.baselineSha}...${candidateSha}`],
      root,
    );
    if (diff.status !== 0) {
      return envelope("agent-verification", "error", started, { root, packetPath, candidateSha }, [
        {
          code: "verification-diff-unavailable",
          message: diff.stderr || "Cannot enumerate changes",
        },
      ]);
    }
    mergeVerification = selectMergeVerification(
      root,
      candidateSha,
      diff.stdout.split(/\r?\n/).filter(Boolean),
      product,
      runner,
    );
  }
  // Canonical capability execution remains authoritative; the affected list is a
  // deterministic minimum, not a substitute for running the repository's existing gates.
  const requiredCapabilities = new Set(evidencePlan.requiredCapabilities);
  if (product && mergeVerification?.mode === "full-required") {
    try {
      for (const component of declaredComponents(root)) {
        for (const capability of Object.keys(component.capabilities) as Capability[]) {
          if (isTestCapability(capability)) requiredCapabilities.add(capability);
        }
      }
    } catch (error) {
      return envelope("agent-verification", "error", started, { root, packetPath, candidateSha }, [
        {
          code: "verification-capability-discovery-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  }
  const results = [...requiredCapabilities].sort().map((capability) => ({
    capability,
    result: check(root, capability),
  }));
  if (mergeVerification) mergeVerification.execution = "full-capability-checks";
  const endingSha = sourceRevision(root, runner);
  if (endingSha !== candidateSha || (product && !exactCheckout(root, candidateSha, runner))) {
    return envelope(
      "agent-verification",
      "unavailable",
      started,
      { root, packetPath, candidateSha, endingSha: endingSha ?? null, results },
      [
        {
          code: "verification-head-moved",
          message:
            "Source revision context changed while verification was running; discard the stale evidence and rerun",
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
  const contractDiagnostics: Diagnostic[] = [];
  if (product) {
    const newTests = runner(
      "git",
      ["diff", "--diff-filter=A", "--name-only", `${read.packet.baselineSha}...${candidateSha}`],
      root,
    );
    if (newTests.status !== 0) {
      return envelope(
        "agent-verification",
        "error",
        started,
        { root, packetPath, candidateSha, results },
        [
          {
            code: "verification-added-tests-unavailable",
            message: newTests.stderr || "Cannot enumerate new tests",
          },
        ],
      );
    }
    const requiredFiles = [
      ...new Set([
        ...product.contracts.map((reference) => reference.path),
        ...newTests.stdout
          .split(/\r?\n/)
          .filter((path) => /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]sx?)$/i.test(path)),
      ]),
    ].sort();
    const componentPaths = declaredComponents(root).map((component) => component.path);
    for (const path of requiredFiles) {
      const declaredCapability = product.contracts.find(
        (contract) => contract.path === path,
      )?.capability;
      const discovered = results.some(
        (entry) =>
          (!declaredCapability || entry.capability === declaredCapability) &&
          entry.result.status === "passed" &&
          Array.isArray(entry.result.data.results) &&
          (
            entry.result.data.results as Array<{
              path: string;
              command: string[];
              testDiscovery?: {
                status: string;
                truncated: boolean;
                discoveredFiles: string[] | null;
              };
              testScope?: { status: string };
            }>
          ).some((check) => {
            if (check.testDiscovery?.status !== "available" || check.testScope?.status !== "matched")
              return false;
            const cwd = resolve(root, check.path);
            const local = relative(cwd, resolve(root, path)).replaceAll("\\", "/");
            if (local.startsWith("../") || local === ".." || local === "") return false;
            if (check.testDiscovery.discoveredFiles?.includes(local)) return true;
            if (!check.testDiscovery.truncated) return false;
            const prefix = check.path === "." ? "" : check.path + "/";
            const excludedSubtrees = componentPaths
              .filter(
                (componentPath) =>
                  componentPath !== "." &&
                  componentPath !== check.path &&
                  (check.path === "." || componentPath.startsWith(prefix)),
              )
              .map((componentPath) =>
                relative(cwd, resolve(root, componentPath)).replaceAll("\\", "/"),
              );
            const evidence = collectTestDiscoveryEvidence({
              cwd,
              capability: entry.capability,
              command: check.command,
              excludedSubtrees,
              requiredFiles: [local],
            });
            return evidence?.status === "available" && evidence.provenRequestedFiles?.includes(local);
          }),
      );
      if (!discovered)
        contractDiagnostics.push({
          code: "verification-acceptance-test-unproven",
          path,
          message: "No passed capability proves this new or pinned acceptance test was executed",
        });
    }
  }
  const statuses = results.map((entry) => entry.result.status);
  const status: ResultStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("failed")
      ? "failed"
      : statuses.includes("unavailable") || contractDiagnostics.length > 0
        ? "unavailable"
        : "passed";
  const diagnostics = [
    ...contractDiagnostics,
    ...results.flatMap((entry) =>
      entry.result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${entry.capability}: ${diagnostic.message}`,
      })),
    ),
  ];
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
      mergeVerification: mergeVerification ?? {
        mode: "full-required",
        reason: "legacy-packet-no-dependency-proof",
        sourceRevision: candidateSha,
        selectedTests: [],
        coreSmokeCapabilities: [],
        coverageBasis: "unproven",
        execution: "full-capability-checks",
      },
      independence: independenceFromPacket(read.packet),
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
  const candidateSha = sourceRevision(root, runner);
  const worktree = cleanWorktree(root, runner);
  if (!candidateSha || worktree.clean !== true) {
    return envelope("agent-handoff", "unavailable", started, { root, packetPath }, [
      {
        code: "handoff-candidate-not-stable",
        message: "Handoff requires a clean worktree bound to a source revision",
      },
    ]);
  }
  if (read.packet.acceptance?.product && !exactCheckout(root, candidateSha, runner)) {
    return envelope("agent-handoff", "unavailable", started, { root, packetPath, candidateSha }, [
      {
        code: "handoff-source-revision-mismatch",
        message: "Product handoff requires the checkout HEAD to equal the candidate revision",
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
  const actionableCandidate = candidates.find((candidate) => candidate.fullyDeferred !== true);
  const deferredCandidate = candidates.find((candidate) => candidate.fullyDeferred === true);
  const strongestNextAction = actionableCandidate
    ? {
        kind: "remediation",
        candidate: actionableCandidate,
      }
    : deferredCandidate
      ? {
          kind: "deferred-remediation",
          candidate: deferredCandidate,
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
    mergeVerification: verification.report.data.mergeVerification ?? null,
    independence: independenceFromPacket(read.packet),
    environment: verification.report.data.environment ?? null,
    semanticReview: {
      required: read.packet.acceptance?.reviewRequirements ?? [],
      machineVerified: false,
      resolved: false,
    },
    unresolvedFindings,
    strongestNextAction,
  });
}
