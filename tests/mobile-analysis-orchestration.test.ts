import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convergeRepository } from "../src/convergence.ts";
import { findingsCommand } from "../src/expectations.ts";

const roots: string[] = [];

const mobileAnalysisRef =
  "moritzbrantner/mobile-analysis/.github/workflows/analyze.yml@bf0b80f0b62b429702c0657a8d4a347243a6e4e0";

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

  test("convergence scaffolds a pinned post-deployment analyzer workflow", () => {
    const root = fixture();
    writeConfig(root);
    writePages(root);

    const before = mobileFindings(root);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      expectationId: "mobile-analysis-orchestration",
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
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(mobileFindings(root)).toEqual([]);
  });

  test("accepts equivalent orchestration pinned to another exact mobile-analysis revision", () => {
    const root = fixture();
    writeConfig(root, "https://example.test/app/", true);
    writePages(root);
    writeFileSync(
      join(root, ".github", "workflows", "mobile-analysis.yml"),
      `name: Mobile analysis\n\non:\n  workflow_run:\n    workflows:\n      - GitHub Pages\n    types: [completed]\n\njobs:\n  analyze:\n    uses: moritzbrantner/mobile-analysis/.github/workflows/analyze.yml@c80a2a8cf7d9611c34c047d0fc1555a0fbb6409a\n    with:\n      target_url: https://example.test/app/\n      config_path: mobile-analysis.config.json\n      run_unlighthouse: true\n`,
    );

    expect(mobileFindings(root)).toEqual([]);
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
      scaffold: undefined,
    });
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
      `name: Mobile analysis\n\non:\n  workflow_dispatch:\n\njobs:\n  analyze:\n    uses: ${mobileAnalysisRef}\n    with:\n      target_url: https://wrong.example.test/\n      config_path: mobile-analysis.config.json\n      run_unlighthouse: false\n`,
    );

    const findings = mobileFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      expectationId: "mobile-analysis-orchestration",
      scaffold: undefined,
    });
  });
});
