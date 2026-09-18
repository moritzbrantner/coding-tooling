import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactReuseEconomics } from "../src/artifact-reuse-economics.ts";

const SHA = "a".repeat(40);

function fixture(metrics: Record<string, unknown>, sourceSha = SHA) {
  return {
    schemaVersion: 1,
    kind: "reusable-workflows/execution-receipt",
    capability: { name: "build-artifact", interfaceVersion: 1 },
    source: { repository: "moritzbrantner/example", sha: sourceSha },
    result: { outcome: "success" },
    metrics: { artifactReuse: metrics },
    evidence: [
      { role: "built-artifact", name: "artifact", digest: `sha256:${"b".repeat(64)}` },
      { role: "artifact-identity", name: "example-v1", digest: `sha256:${"c".repeat(64)}` },
    ],
    run: { id: "123" },
  };
}

function writeReceipt(document: unknown): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-artifact-reuse-"));
  const path = join(root, ".artifacts/reusable-workflows/build-artifact-receipt.json");
  mkdirSync(join(root, ".artifacts/reusable-workflows"), { recursive: true });
  writeFileSync(path, JSON.stringify(document), "utf8");
  return { root, path };
}

describe("artifact reuse economics", () => {
  test("reports a current high-fan-out artifact as recommended", () => {
    const { root } = writeReceipt(
      fixture({
        expectedConsumers: 4,
        setupMs: 20000,
        buildMs: 60000,
        uploadMs: 5000,
        artifactBytes: 1000000,
        estimatedAvoidedBuildMs: 180000,
        producerOverheadMs: 25000,
        recommended: true,
        reason: "build-cost-dominates-reuse-overhead",
      }),
    );
    const result = artifactReuseEconomics(root, { expectedHeadSha: SHA });
    expect(result.status).toBe("passed");
    expect(result.data.classification).toBe("recommended");
    expect(result.data.estimatedNetAvoidedMs).toBe(155000);
  });

  test("keeps a valid but cheap artifact advisory", () => {
    const { root } = writeReceipt(
      fixture({
        expectedConsumers: 4,
        setupMs: 95000,
        buildMs: 8000,
        uploadMs: 2000,
        artifactBytes: 1000,
        estimatedAvoidedBuildMs: 24000,
        producerOverheadMs: 97000,
        recommended: false,
        reason: "producer-overhead-dominates",
      }),
    );
    const result = artifactReuseEconomics(root, { expectedHeadSha: SHA });
    expect(result.status).toBe("passed");
    expect(result.data.classification).toBe("not-cost-effective");
    expect(
      result.diagnostics.some((item) => item.code === "artifact-reuse-not-recommended"),
    ).toBe(true);
  });

  test("rejects stale exact-head evidence", () => {
    const { root } = writeReceipt(
      fixture({
        expectedConsumers: 3,
        setupMs: 1,
        buildMs: 10,
        uploadMs: 1,
        artifactBytes: 10,
        estimatedAvoidedBuildMs: 20,
        producerOverheadMs: 2,
        recommended: true,
        reason: "build-cost-dominates-reuse-overhead",
      },
        "b".repeat(40),
      ),
    );
    const result = artifactReuseEconomics(root, { expectedHeadSha: SHA });
    expect(result.status).toBe("unavailable");
    expect(
      result.diagnostics.some((item) => item.code === "artifact-reuse-evidence-stale"),
    ).toBe(true);
  });
});
