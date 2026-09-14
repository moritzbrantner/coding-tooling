import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ResultEnvelope, type ResultOperation } from "../src/model.ts";
import { runSourceAwarePipeline } from "../src/source-aware-pipeline.ts";

function envelope(
  operation: ResultOperation,
  status: ResultEnvelope<Record<string, unknown>>["status"] = "passed",
): ResultEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: 1,
    data: {},
    diagnostics:
      status === "passed" ? [] : [{ code: "source-graph-revision-conflict", message: "conflict" }],
  };
}

test("fails before source activation when the transitive source graph conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-source-graph-gate-"));
  try {
    writeFileSync(
      join(root, ".coding-tooling.source-deps.json"),
      `${JSON.stringify({ schemaVersion: 2, cargo: { localOnly: true, patches: [] } }, null, 2)}\n`,
    );
    let activationCalls = 0;
    let pipelineCalls = 0;
    const execution = runSourceAwarePipeline(root, "full", {
      verifySourceGraph: () => envelope("source-deps", "failed"),
      sourceDependencies: () => {
        activationCalls += 1;
        return envelope("source-deps");
      },
      runPipeline: () => {
        pipelineCalls += 1;
        return envelope("run");
      },
    });

    expect(execution.pipeline.status).toBe("failed");
    expect(execution.pipeline.data.phase).toBe("source-graph-verification");
    expect(activationCalls).toBe(0);
    expect(pipelineCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
