import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convergeRepository } from "../src/convergence.ts";
import { findingsCommand } from "../src/expectations.ts";

const roots: string[] = [];

const mobileAnalysisRef =
  "moritzbrantner/mobile-analysis/.github/workflows/analyze.yml@4a9e5b24d8acd9753830b45f82968341b56d8d41";
const codingToolingRef =
  "moritzbrantner/coding-tooling@1bb73191e4a7e62ef5a228e7066dba649cc14073";
const checkoutRef = "actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8";
const downloadArtifactRef =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const uploadArtifactRef =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const deploymentRevisionExpression =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}";
const deploymentHeadShaExpression = "${{ github.event.workflow_run.head_sha }}";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-mobile-orchestration-"));
  roots.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  return root;
}

function writeConfig(
  root: string,
  targetUrl = "https://example.test/app/",
  unlighthouse = false,
): void {
  writeFileSync(
    join(root, "mobile-analysis.config.json"),
    `${JSON.stringify(
      {
        target: { name: "Example", baseUrl: targetUrl },
        routes: ["/"],
        unlighthouse: { enabled: unlighthouse, budget: 80 },
      },
      null,
      2,
    )}\n`,
  );
}

function writePages(root: string, file = "pages.yml", name = "GitHub Pages"): void {
  writeFileSync(
    join(root, ".github", "workflows", file),
    `name: ${name}\n\non:\n  push:\n    branches: [main]\n\npermissions:\n  pages: write\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@v4\n`,
  );
}

function mobileFindings(root: string) {
  const result = findingsCommand(root, { includeSuppressed: false });
  return Array.isArray(result.data.findings)
    ? result.data.findings.filter(
        (finding) =>
          typeof finding === "object" &&
          finding !== null &&
          "expectationId" in finding &&
          finding.expectationId === "mobile-analysis-orchestration",
      )
    : [];
}

describe("mobile-analysis orchestration", () => {
  test("is not applicable without explicit config and a Pages deployment", () => {
    const root = fixture();
    writePages(root);
    expect(mobileFindings(root)).toEqual([]);

    const configured = fixture();
    writeConfig(configured);
    expect(mobileFindings(configured)).toEqual([]);
  });

  test("convergence scaffolds exact-revision analysis and same-run remediation continuation", () => {
    const root = fixture();
    writeConfig(root);
    writePages(root);

    const before = mobileFindings(root);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      expectationId: "mobile-analysis-orchestration",
      expectationVersion: 2,
      requirement: { key: "mobile-analysis-orchestration" },
      scaffold: { kind: "create-file", path: ".github/workflows/mobile-analysis.yml" },
    });

    const result = convergeRepository(root, { verifyTier: null });
    const workflowPath = join(root, ".github", "workflows", "mobile-analysis.yml");

    expect(result.status).toBe("passed");
    expect(result.data).toMatchObject({ result: "converged", finalFindingIds: [] });
    expect(existsSync(workflowPath)).toBeTrue();
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain(`uses: ${mobileAnalysisRef}`);
    expect(workflow).toContain('target_url: "https://example.test/app/"');
    expect(workflow).toContain("config_path: mobile-analysis.config.json");
    expect(workflow).toContain("run_unlighthouse: false");
    expect(workflow).toContain(`revision: ${deploymentRevisionExpression}`);
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("prioritize:");
    expect(workflow).toContain("github.event_name == 'workflow_run' && needs.analyze.result == 'success'");
    expect(workflow).toContain(`uses: ${checkoutRef}`);
    expect(workflow).toContain(`ref: ${deploymentHeadShaExpression}`);
    expect(workflow).toContain(`uses: ${downloadArtifactRef}`);
    expect(workflow).toContain("name: mobile-analysis");
    expect(workflow).toContain("path: mobile-analysis-output");
    expect(workflow).toContain(
      `MOBILE_ANALYSIS_EXPECTED_REVISION: ${deploymentHeadShaExpression}`,
    );
    expect(workflow).toContain('readFileSync("mobile-analysis-output/agent-findings.json", "utf8")');
    expect(workflow).toContain('report.producer !== "mobile-analysis"');
    expect(workflow).toContain("report.revision !== expected");
    expect(workflow).toContain(`uses: ${codingToolingRef}`);
    expect(workflow).toContain("operation: remediation-plan");
    expect(workflow).toContain(
      "report-path: .artifacts/coding-tooling/mobile-remediation-plan.json",
    );
    expect(workflow).toContain(`uses: ${uploadArtifactRef}`);
    expect(workflow).toContain("name: coding-tooling-mobile-remediation");
    expect(mobileFindings(root)).toEqual([]);
  });

  test("rejects legacy analyzer-only orchestration even when exact-pinned", () => {
    const root = fixture();
    writeConfig(root, "https://example.test/app/", true);
    writePages(root);
    writeFileSync(
      join(root, ".github", "workflows", "mobile-analysis.yml"),
      `name: Mobile analysis\n\non:\n  workflow_run:\n    workflows:\n      - GitHub Pages\n    types: [completed]\n\njobs:\n  analyze:\n    if: \${{ github.event.workflow_run.conclusion == 'success' }}\n    uses: ${mobileAnalysisRef}\n    with:\n      target_url: https://example.test/app/\n      config_path: mobile-analysis.config.json\n      run_unlighthouse: true\n`,
    );

    const findings = mobileFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      expectationId: "mobile-analysis-orchestration",
      expectationVersion: 2,
    });
    expect((findings[0] as { scaffold?: unknown }).scaffold).toBeUndefined();
    expect((findings[0] as { message: string }).message).toContain(
      "same-run evidence provenance",
    );
  });

  test("rejects orchestration that can run after an unsuccessful deployment", () => {
    const root = fixture();
    writeConfig(root);
    writePages(root);
    writeFileSync(
      join(root, ".github", "workflows", "mobile-analysis.yml"),
      `name: Mobile analysis\n\non:\n  workflow_run:\n    workflows:\n      - GitHub Pages\n    types: [completed]\n\njobs:\n  analyze:\n    uses: ${mobileAnalysisRef}\n    with:\n      target_url: https://example.test/app/\n      config_path: mobile-analysis.config.json\n      run_unlighthouse: false\n      revision: ${deploymentRevisionExpression}\n`,
    );

    const findings = mobileFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ expectationId: "mobile-analysis-orchestration" });
    expect((findings[0] as { scaffold?: unknown }).scaffold).toBeUndefined();
  });

  test("fails closed when the Pages deployment boundary is ambiguous", () => {
    const root = fixture();
    writeConfig(root);
    writePages(root, "pages-a.yml", "Pages A");
    writePages(root, "pages-b.yml", "Pages B");

    const findings = mobileFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      expectationId: "mobile-analysis-orchestration",
    });
    expect((findings[0] as { scaffold?: unknown }).scaffold).toBeUndefined();
    expect((findings[0] as { message: string }).message).toContain(
      "will not guess which deployment should trigger mobile-analysis",
    );
  });

  test("does not overwrite conflicting analyzer orchestration", () => {
    const root = fixture();
    writeConfig(root);
    writePages(root);
    writeFileSync(
      join(root, ".github", "workflows", "mobile-analysis.yml"),
      `name: Mobile analysis\n\non:\n  workflow_dispatch:\n\njobs:\n  analyze:\n    uses: ${mobileAnalysisRef}\n    with:\n      target_url: https://wrong.example.test/\n      config_path: mobile-analysis.config.json\n      run_unlighthouse: false\n      revision: ${deploymentRevisionExpression}\n`,
    );

    const findings = mobileFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      expectationId: "mobile-analysis-orchestration",
    });
    expect((findings[0] as { scaffold?: unknown }).scaffold).toBeUndefined();
  });
});
