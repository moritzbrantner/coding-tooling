import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { foundationAudit } from "./foundation-audit.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readRepositoryMetadata } from "./repository-metadata.ts";
import { type CommandResult, readJson, runCommand } from "./shared.ts";

export type MergeReadiness =
  | "not-ready"
  | "local-gated"
  | "protection-required"
  | "trusted-auto-merge";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

type MergeConfig = {
  authority?: unknown;
  reason?: unknown;
  requiredChecks?: unknown;
};

type ToolingConfigWithMerge = {
  merge?: MergeConfig;
};

type SourceDependencyConfig = {
  schemaVersion?: unknown;
  cargo?: {
    localOnly?: unknown;
  };
};

type RepositoryInfo = {
  defaultBranchRef?: {
    name?: unknown;
  };
};

type BranchInfo = {
  protected?: unknown;
  protection?: {
    required_status_checks?: {
      contexts?: unknown;
      checks?: unknown;
    };
  };
};

type MergePolicy = {
  authority?: "hosted" | "local";
  reason?: string;
  requiredChecks: string[];
  diagnostics: Diagnostic[];
};

type RemoteProtection = {
  available: boolean;
  branch?: string;
  protected: boolean;
  requiredChecks: string[];
  diagnostics: Diagnostic[];
};

export type FleetMergeReadinessOptions = {
  run?: Runner;
};

function repositoryDirectories(fleetRoot: string): string[] {
  try {
    return readdirSync(fleetRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(fleetRoot, entry.name))
      .filter((path) => existsSync(join(path, ".git")))
      .sort();
  } catch {
    return [];
  }
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry))]
    .sort();
}

function mergePolicy(root: string): MergePolicy {
  const config = readJson<ToolingConfigWithMerge>(join(root, ".coding-tooling.json"));
  const merge = config?.merge;
  const diagnostics: Diagnostic[] = [];
  const requiredChecks = strings(merge?.requiredChecks);
  const authority =
    merge?.authority === "hosted" || merge?.authority === "local" ? merge.authority : undefined;
  const reason = typeof merge?.reason === "string" && merge.reason.trim() ? merge.reason.trim() : undefined;

  if (!authority) {
    diagnostics.push({
      code: "merge-authority-undeclared",
      message:
        '.coding-tooling.json must declare merge.authority as "hosted" or "local" before unattended merge readiness can be established',
      path: ".coding-tooling.json",
    });
  }
  if (authority === "local" && !reason) {
    diagnostics.push({
      code: "local-merge-authority-reason-missing",
      message: "Local merge authority must include merge.reason so the guarded boundary is explicit",
      path: ".coding-tooling.json",
    });
  }
  if (authority === "hosted" && requiredChecks.length === 0) {
    diagnostics.push({
      code: "hosted-required-checks-empty",
      message: "Hosted merge authority must declare at least one merge.requiredChecks entry",
      path: ".coding-tooling.json",
    });
  }

  return { authority, reason, requiredChecks, diagnostics };
}

function localOnlySourceGraph(root: string): boolean {
  const config = readJson<SourceDependencyConfig>(join(root, ".coding-tooling.source-deps.json"));
  return config?.schemaVersion === 2 && config.cargo?.localOnly === true;
}

function parseJson<T>(result: CommandResult): T | undefined {
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

function remoteProtection(
  runner: Runner,
  root: string,
  repository: string,
): RemoteProtection {
  const repositoryResult = runner(
    "gh",
    ["repo", "view", repository, "--json", "defaultBranchRef"],
    root,
  );
  const repositoryInfo = parseJson<RepositoryInfo>(repositoryResult);
  const branch = repositoryInfo?.defaultBranchRef?.name;
  if (typeof branch !== "string" || !branch) {
    return {
      available: false,
      protected: false,
      requiredChecks: [],
      diagnostics: [
        {
          code: "merge-remote-default-branch-unavailable",
          message:
            repositoryResult.stderr.trim() ||
            repositoryResult.error ||
            `Could not read the default branch for ${repository}`,
        },
      ],
    };
  }

  const branchResult = runner("gh", ["api", `repos/${repository}/branches/${branch}`], root);
  const branchInfo = parseJson<BranchInfo>(branchResult);
  if (!branchInfo) {
    return {
      available: false,
      branch,
      protected: false,
      requiredChecks: [],
      diagnostics: [
        {
          code: "merge-remote-protection-unavailable",
          message:
            branchResult.stderr.trim() ||
            branchResult.error ||
            `Could not read protection evidence for ${repository}:${branch}`,
        },
      ],
    };
  }

  const statusChecks = branchInfo.protection?.required_status_checks;
  const contexts = strings(statusChecks?.contexts);
  const checks = Array.isArray(statusChecks?.checks)
    ? statusChecks.checks
        .map((entry) =>
          entry && typeof entry === "object" && typeof (entry as { context?: unknown }).context === "string"
            ? (entry as { context: string }).context
            : undefined,
        )
        .filter((entry): entry is string => Boolean(entry))
    : [];

  return {
    available: true,
    branch,
    protected: branchInfo.protected === true,
    requiredChecks: [...new Set([...contexts, ...checks])].sort(),
    diagnostics: [],
  };
}

function classify(
  foundationStatus: ResultStatus,
  policy: MergePolicy,
  localOnly: boolean,
  protection: RemoteProtection | undefined,
): { readiness: MergeReadiness; blockers: Diagnostic[] } {
  const blockers: Diagnostic[] = [...policy.diagnostics];
  if (foundationStatus !== "passed") {
    blockers.push({
      code: "merge-foundation-not-ready",
      message: `Repository foundation audit is ${foundationStatus}`,
    });
    return { readiness: "not-ready", blockers };
  }

  if (localOnly) {
    if (policy.authority === "hosted") {
      blockers.push({
        code: "merge-hosted-authority-conflicts-with-local-source",
        message:
          "A schema-version-2 localOnly source graph requires the stronger local integration path and cannot be trusted for unattended hosted merging",
        path: ".coding-tooling.source-deps.json",
      });
    }
    return { readiness: "local-gated", blockers };
  }

  if (!policy.authority || policy.diagnostics.length > 0) {
    return { readiness: "not-ready", blockers };
  }
  if (policy.authority === "local") return { readiness: "local-gated", blockers };

  if (!protection?.available) {
    blockers.push(...(protection?.diagnostics ?? []));
    return { readiness: "protection-required", blockers };
  }
  if (!protection.protected) {
    blockers.push({
      code: "merge-target-branch-unprotected",
      message: `Target branch ${protection.branch ?? "unknown"} is not protected`,
    });
    return { readiness: "protection-required", blockers };
  }
  if (protection.requiredChecks.length === 0) {
    blockers.push({
      code: "merge-required-checks-zero",
      message: "Protected branch has zero required status checks; zero checks is never green",
    });
    return { readiness: "protection-required", blockers };
  }

  const missingRequiredChecks = policy.requiredChecks.filter(
    (check) => !protection.requiredChecks.includes(check),
  );
  if (missingRequiredChecks.length > 0) {
    blockers.push({
      code: "merge-required-checks-not-protected",
      message: `Required merge checks are not protected: ${missingRequiredChecks.join(", ")}`,
    });
    return { readiness: "protection-required", blockers };
  }

  return { readiness: "trusted-auto-merge", blockers };
}

export function fleetMergeReadiness(
  fleetRoot: string,
  options: FleetMergeReadinessOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(fleetRoot);
  const runner = options.run ?? runCommand;
  const repositories = repositoryDirectories(root).map((repositoryRoot) => {
    const metadata = readRepositoryMetadata(repositoryRoot);
    const foundation = foundationAudit(repositoryRoot);
    const policy = mergePolicy(repositoryRoot);
    const localOnly = localOnlySourceGraph(repositoryRoot);
    const repositoryId = metadata.metadata?.id;
    const protection =
      repositoryId && foundation.status === "passed" && policy.authority === "hosted" && !localOnly
        ? remoteProtection(runner, repositoryRoot, repositoryId)
        : undefined;
    const classification = classify(foundation.status, policy, localOnly, protection);

    return {
      name: basename(repositoryRoot),
      root: repositoryRoot,
      repository: repositoryId ?? null,
      readiness: classification.readiness,
      blockers: classification.blockers,
      evidence: {
        foundationStatus: foundation.status,
        mergeAuthority: policy.authority ?? null,
        mergeReason: policy.reason ?? null,
        requiredChecks: policy.requiredChecks,
        localOnlySourceGraph: localOnly,
        remote: protection ?? null,
      },
    };
  });

  if (repositories.length === 0) {
    return {
      schemaVersion: 1,
      operation: "fleet",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: { root, repositories },
      diagnostics: [
        {
          code: "fleet-repositories-unavailable",
          message: `No direct child Git repositories found under ${root}`,
        },
      ],
    };
  }

  const status: ResultStatus = repositories.some(
    (repository) =>
      repository.readiness === "not-ready" || repository.readiness === "protection-required",
  )
    ? "failed"
    : "passed";

  return {
    schemaVersion: 1,
    operation: "fleet",
    status,
    durationMs: Date.now() - started,
    data: {
      root,
      repositories,
      summary: {
        notReady: repositories.filter((entry) => entry.readiness === "not-ready").length,
        localGated: repositories.filter((entry) => entry.readiness === "local-gated").length,
        protectionRequired: repositories.filter((entry) => entry.readiness === "protection-required").length,
        trustedAutoMerge: repositories.filter((entry) => entry.readiness === "trusted-auto-merge").length,
      },
    },
    diagnostics: [],
  };
}
