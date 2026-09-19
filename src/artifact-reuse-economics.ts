import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";

type ArtifactReuseMetrics = {
  expectedConsumers: number;
  setupMs: number;
  buildMs: number;
  uploadMs: number;
  artifactBytes: number;
  estimatedAvoidedBuildMs: number;
  producerOverheadMs: number;
  recommended: boolean;
  reason: string;
};

type Receipt = {
  schemaVersion?: unknown;
  kind?: unknown;
  capability?: { name?: unknown; interfaceVersion?: unknown };
  source?: { repository?: unknown; sha?: unknown };
  result?: { outcome?: unknown };
  metrics?: { artifactReuse?: Partial<ArtifactReuseMetrics> };
  evidence?: Array<{ role?: unknown; name?: unknown; digest?: unknown }>;
  run?: { id?: unknown };
};

function envelope(
  status: ResultEnvelope<Record<string, unknown>>["status"],
  started: number,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation: "artifact-reuse",
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

function currentHead(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function parseMetrics(receipt: Receipt): ArtifactReuseMetrics | undefined {
  const value = receipt.metrics?.artifactReuse;
  if (!value) return undefined;
  if (
    !Number.isInteger(value.expectedConsumers) ||
    Number(value.expectedConsumers) < 1 ||
    !nonNegativeInteger(value.setupMs) ||
    !nonNegativeInteger(value.buildMs) ||
    !nonNegativeInteger(value.uploadMs) ||
    !nonNegativeInteger(value.artifactBytes) ||
    !nonNegativeInteger(value.estimatedAvoidedBuildMs) ||
    !nonNegativeInteger(value.producerOverheadMs) ||
    typeof value.recommended !== "boolean" ||
    typeof value.reason !== "string" ||
    value.reason.length === 0
  )
    return undefined;
  return value as ArtifactReuseMetrics;
}

export function artifactReuseEconomics(
  root: string,
  options: { receiptPath?: string; expectedHeadSha?: string } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const receiptPath = resolve(
    root,
    options.receiptPath ?? ".artifacts/reusable-workflows/build-artifact-receipt.json",
  );

  if (!existsSync(receiptPath))
    return envelope("unavailable", started, { profile: "ci-artifact-reuse/v1", receiptPath }, [
      {
        code: "artifact-reuse-evidence-missing",
        message: `No build-artifact receipt at ${receiptPath}`,
      },
    ]);

  let receipt: Receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
  } catch (error) {
    return envelope("error", started, { profile: "ci-artifact-reuse/v1", receiptPath }, [
      {
        code: "artifact-reuse-evidence-invalid-json",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  const diagnostics: Diagnostic[] = [];
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "reusable-workflows/execution-receipt" ||
    receipt.capability?.name !== "build-artifact" ||
    receipt.capability?.interfaceVersion !== 1
  )
    diagnostics.push({
      code: "artifact-reuse-evidence-wrong-contract",
      message: "Receipt is not a reusable-workflows build-artifact/v1 execution receipt.",
    });

  if (receipt.result?.outcome !== "success")
    diagnostics.push({
      code: "artifact-reuse-evidence-not-successful",
      message: "Artifact reuse economics require a successful producer receipt.",
    });

  const metrics = parseMetrics(receipt);
  if (!metrics)
    diagnostics.push({
      code: "artifact-reuse-economics-missing",
      message: "Receipt does not contain a valid metrics.artifactReuse payload.",
    });

  const sourceSha = typeof receipt.source?.sha === "string" ? receipt.source.sha.toLowerCase() : "";
  const expectedHead = (options.expectedHeadSha ?? currentHead(root)).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || sourceSha !== expectedHead)
    diagnostics.push({
      code: "artifact-reuse-evidence-stale",
      message: `Receipt source ${sourceSha || "unknown"} does not match exact HEAD ${expectedHead}.`,
    });

  const artifacts = Array.isArray(receipt.evidence)
    ? receipt.evidence.filter((entry) => entry?.role === "built-artifact")
    : [];
  const identities = Array.isArray(receipt.evidence)
    ? receipt.evidence.filter((entry) => entry?.role === "artifact-identity")
    : [];
  if (artifacts.length !== 1 || identities.length !== 1)
    diagnostics.push({
      code: "artifact-reuse-evidence-identity-invalid",
      message:
        "Receipt must contain exactly one built-artifact and one artifact-identity evidence entry.",
    });

  if (diagnostics.length > 0)
    return envelope(
      "unavailable",
      started,
      { profile: "ci-artifact-reuse/v1", receiptPath },
      diagnostics,
    );

  const classification = metrics!.recommended
    ? "recommended"
    : metrics!.expectedConsumers < 3
      ? "insufficient-fan-out"
      : "not-cost-effective";
  const estimatedNetAvoidedMs = metrics!.estimatedAvoidedBuildMs - metrics!.producerOverheadMs;

  if (!metrics!.recommended)
    diagnostics.push({
      code: "artifact-reuse-not-recommended",
      message: `Artifact reuse is advisory-only and currently ${classification}: ${metrics!.reason}.`,
    });

  return envelope(
    "passed",
    started,
    {
      profile: "ci-artifact-reuse/v1",
      receiptPath,
      sourceSha,
      producerRunId: receipt.run?.id,
      artifactKey: identities[0]?.name,
      artifactDigest: artifacts[0]?.digest,
      classification,
      estimatedNetAvoidedMs,
      economics: metrics,
    },
    diagnostics,
  );
}
