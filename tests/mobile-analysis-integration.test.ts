import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeProvider } from "../src/analysis.ts";
import { planRemediationCandidates } from "../src/remediation-plan.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-mobile-analysis-"));
  roots.push(root);
  mkdirSync(join(root, "mobile-analysis-output", "screenshots"), { recursive: true });
  return root;
}

function writeContract(root: string): void {
  writeFileSync(
    join(root, "mobile-analysis-output", "agent-findings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        producer: "mobile-analysis",
        createdAt: "2026-09-16T00:00:00.000Z",
        target: { name: "Example", baseUrl: "https://example.com/app/" },
        findings: [
          {
            id: "MA-AAAAAAAAAAAA",
            sourceFindingId: "scenario:pixel:settings",
            source: "playwright",
            category: "interaction",
            severity: "error",
            title: "Scenario failed: Open settings",
            details: "Settings button was not visible",
            reproducibility: "deterministic",
            context: {
              deviceId: "pixel",
              scenarioId: "settings",
              url: "https://example.com/app/",
            },
            evidence: [
              { kind: "screenshot", value: "screenshots/pixel-settings-final.png" },
              { kind: "url", value: "https://example.com/app/" },
            ],
          },
          {
            id: "MA-BBBBBBBBBBBB",
            sourceFindingId: "small-touch-targets:pixel:settings",
            source: "playwright",
            category: "accessibility",
            severity: "warning",
            title: "1 small interactive target(s) found",
            details: "Save: 28x28",
            reproducibility: "advisory",
            context: {
              deviceId: "pixel",
              scenarioId: "settings",
              url: "https://example.com/app/",
            },
            evidence: [
              { kind: "screenshot", value: "screenshots/pixel-settings-final.png" },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

describe("mobile-analysis evidence integration", () => {
  test("consumes the versioned agent contract as analysis diagnostics", () => {
    const root = fixture();
    writeContract(root);

    const provider = analyzeProvider(root, "mobile-analysis");

    expect(provider).toMatchObject({
      id: "mobile-analysis",
      displayName: "mobile-analysis evidence",
      version: "agent-findings/v1",
      status: "applied",
      capabilities: ["diagnostics"],
      projects: ["mobile-analysis-output/agent-findings.json"],
    });
    expect(provider?.diagnostics).toHaveLength(2);
    expect(provider?.diagnostics[0]).toMatchObject({
      code: "MA-AAAAAAAAAAAA",
      severity: "error",
      location: { path: "mobile-analysis-output/screenshots/pixel-settings-final.png" },
      metadata: {
        category: "interaction",
        reproducibility: "deterministic",
        context: { scenarioId: "settings", deviceId: "pixel" },
      },
    });
  });

  test("ranks mobile findings as agent handoff candidates used by convergence", () => {
    const root = fixture();
    writeContract(root);

    const candidates = planRemediationCandidates([], { root });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "implementation",
      priority: 0,
      subject: {
        kind: "repository",
        key: "mobile-scenario:settings",
        description: "mobile scenario settings",
      },
      findingIds: ["MA-AAAAAAAAAAAA", "MA-BBBBBBBBBBBB"],
      expectationIds: ["mobile-analysis"],
      severities: ["error", "warning"],
      requiresAgent: true,
      verification: [["coding-tooling", "analyze", "--json"]],
    });
    expect(candidates[0]?.relatedFiles).toEqual([
      "mobile-analysis-output/agent-findings.json",
      "mobile-analysis-output/screenshots/pixel-settings-final.png",
    ]);
  });

  test("fails closed on an invalid producer contract", () => {
    const root = fixture();
    writeFileSync(
      join(root, "mobile-analysis-output", "agent-findings.json"),
      '{"schemaVersion":2,"producer":"mobile-analysis","target":{},"findings":[]}\n',
    );

    expect(analyzeProvider(root, "mobile-analysis")).toMatchObject({
      id: "mobile-analysis",
      status: "failed",
      diagnostics: [],
      actions: [],
    });
  });
});
