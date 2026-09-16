import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix, walkFiles } from "./shared.ts";

const configName = "mobile-analysis.config.json";
const generatedWorkflowPath = ".github/workflows/mobile-analysis.yml";
const mobileAnalysisWorkflowRef =
  "moritzbrantner/mobile-analysis/.github/workflows/analyze.yml@4a9e5b24d8acd9753830b45f82968341b56d8d41";
const codingToolingActionRef =
  "moritzbrantner/coding-tooling@1bb73191e4a7e62ef5a228e7066dba649cc14073";
const checkoutActionRef = "actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8";
const downloadArtifactActionRef =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const uploadArtifactActionRef = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const setupNodeActionRef = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const deploymentRevisionExpression =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}";
const deploymentHeadShaExpression = "${{ github.event.workflow_run.head_sha }}";
const pagesDeploymentPattern =
  /(?:actions\/upload-pages-artifact|actions\/deploy-pages|deploy-pages\.ya?ml|pages:\s*write)/i;
const mobileAnalysisCallPattern =
  /moritzbrantner\/mobile-analysis\/\.github\/workflows\/analyze\.yml@[0-9a-f]{40}/i;
const completedWorkflowRunPattern = /types:\s*(?:\[\s*completed\s*\]|\r?\n\s*-\s*completed)/i;
const successfulWorkflowRunPattern = /workflow_run\.conclusion\s*==\s*["']success["']/i;

type PagesWorkflow = {
  path: string;
  name: string;
};

type MobileAnalysisConfig = {
  targetUrl: string;
  runUnlighthouse: boolean;
};

function workflowFiles(root: string): string[] {
  return walkFiles(join(root, ".github", "workflows"), 2)
    .filter((path) => [".yml", ".yaml"].includes(extname(path)))
    .sort();
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function workflowName(content: string, path: string): string {
  const match = content.match(/^name:\s*(.+?)\s*(?:#.*)?$/m);
  return match?.[1] ? unquote(match[1]) : path;
}

function pagesWorkflows(root: string): PagesWorkflow[] {
  return workflowFiles(root).flatMap((path) => {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    if (!pagesDeploymentPattern.test(content)) return [];
    const workflowPath = relativePosix(root, path);
    return [{ path: workflowPath, name: workflowName(content, workflowPath) }];
  });
}

function parseConfig(root: string): { config?: MobileAnalysisConfig; error?: string } {
  const path = join(root, configName);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `${configName} must contain a JSON object` };
    }
    const rootValue = value as Record<string, unknown>;
    const target = rootValue.target;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return { error: `${configName}.target must be an object` };
    }
    const baseUrl = (target as Record<string, unknown>).baseUrl;
    if (typeof baseUrl !== "string" || !baseUrl.trim()) {
      return { error: `${configName}.target.baseUrl must be a non-empty string` };
    }
    const targetUrl = baseUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { error: `${configName}.target.baseUrl must be a valid URL` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { error: `${configName}.target.baseUrl must use http or https` };
    }

    const unlighthouse = rootValue.unlighthouse;
    const enabled =
      unlighthouse && typeof unlighthouse === "object" && !Array.isArray(unlighthouse)
        ? (unlighthouse as Record<string, unknown>).enabled
        : undefined;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return { error: `${configName}.unlighthouse.enabled must be a boolean when present` };
    }
    return {
      config: {
        targetUrl,
        runUnlighthouse: enabled ?? true,
      },
    };
  } catch (error) {
    return {
      error: `${configName} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function scalar(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*(?:#.*)?$`, "m");
  const value = content.match(pattern)?.[1];
  return value ? unquote(value) : undefined;
}

function referencesSuccessfulDeployment(content: string, page: PagesWorkflow): boolean {
  return (
    content.includes("workflow_run:") &&
    content.includes(page.name) &&
    completedWorkflowRunPattern.test(content) &&
    successfulWorkflowRunPattern.test(content)
  );
}

function analysisWorkflowPaths(root: string): Array<{ path: string; content: string }> {
  return workflowFiles(root).flatMap((path) => {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    if (!mobileAnalysisCallPattern.test(content)) return [];
    return [{ path: relativePosix(root, path), content }];
  });
}

function hasArtifactContinuation(content: string): boolean {
  return (
    content.includes("prioritize:") &&
    content.includes("needs: analyze") &&
    content.includes("github.event_name == 'workflow_run' && needs.analyze.result == 'success'") &&
    content.includes(`uses: ${checkoutActionRef}`) &&
    content.includes(`ref: ${deploymentHeadShaExpression}`) &&
    content.includes(`uses: ${downloadArtifactActionRef}`) &&
    content.includes("name: mobile-analysis") &&
    content.includes("path: mobile-analysis-output") &&
    content.includes(`uses: ${setupNodeActionRef}`) &&
    content.includes(`MOBILE_ANALYSIS_EXPECTED_REVISION: ${deploymentHeadShaExpression}`) &&
    content.includes('readFileSync("mobile-analysis-output/agent-findings.json", "utf8")') &&
    content.includes('report.producer !== "mobile-analysis"') &&
    content.includes("report.revision !== expected") &&
    content.includes(`uses: ${codingToolingActionRef}`) &&
    content.includes("operation: remediation-plan") &&
    content.includes("report-path: .artifacts/coding-tooling/mobile-remediation-plan.json") &&
    content.includes(`uses: ${uploadArtifactActionRef}`) &&
    content.includes("name: coding-tooling-mobile-remediation")
  );
}

function isCorrectlyWired(
  content: string,
  page: PagesWorkflow,
  config: MobileAnalysisConfig,
): boolean {
  return (
    content.includes(`uses: ${mobileAnalysisWorkflowRef}`) &&
    referencesSuccessfulDeployment(content, page) &&
    scalar(content, "target_url") === config.targetUrl &&
    scalar(content, "config_path") === configName &&
    scalar(content, "run_unlighthouse") === String(config.runUnlighthouse) &&
    scalar(content, "revision") === deploymentRevisionExpression &&
    hasArtifactContinuation(content)
  );
}

function generatedWorkflow(page: PagesWorkflow, config: MobileAnalysisConfig): string {
  return `name: Mobile analysis\n\non:\n  workflow_dispatch:\n  workflow_run:\n    workflows:\n      - ${yamlScalar(page.name)}\n    types:\n      - completed\n\npermissions:\n  contents: read\n\njobs:\n  analyze:\n    if: \${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}\n    uses: ${mobileAnalysisWorkflowRef}\n    with:\n      target_url: ${yamlScalar(config.targetUrl)}\n      config_path: ${configName}\n      run_unlighthouse: ${String(config.runUnlighthouse)}\n      revision: ${deploymentRevisionExpression}\n\n  prioritize:\n    needs: analyze\n    if: \${{ github.event_name == 'workflow_run' && needs.analyze.result == 'success' }}\n    runs-on: ubuntu-latest\n    steps:\n      - name: Checkout analyzed revision\n        uses: ${checkoutActionRef}\n        with:\n          ref: ${deploymentHeadShaExpression}\n      - name: Download mobile evidence\n        uses: ${downloadArtifactActionRef}\n        with:\n          name: mobile-analysis\n          path: mobile-analysis-output\n      - name: Set up Node.js\n        uses: ${setupNodeActionRef}\n        with:\n          node-version: "22"\n      - name: Verify mobile evidence provenance\n        env:\n          MOBILE_ANALYSIS_EXPECTED_REVISION: ${deploymentHeadShaExpression}\n        run: |\n          node --input-type=module <<'NODE'\n          import { readFileSync } from "node:fs";\n          const expected = process.env.MOBILE_ANALYSIS_EXPECTED_REVISION?.toLowerCase();\n          if (!expected || !/^[0-9a-f]{40}$/.test(expected)) {\n            throw new Error("expected mobile-analysis revision must be an exact Git SHA");\n          }\n          const report = JSON.parse(\n            readFileSync("mobile-analysis-output/agent-findings.json", "utf8"),\n          );\n          if (report.producer !== "mobile-analysis" || report.revision !== expected) {\n            throw new Error(\n              "mobile-analysis artifact revision mismatch: expected " +\n                expected +\n                ", received " +\n                String(report.revision),\n            );\n          }\n          NODE\n      - name: Plan mobile remediation\n        uses: ${codingToolingActionRef}\n        with:\n          operation: remediation-plan\n          report-path: .artifacts/coding-tooling/mobile-remediation-plan.json\n      - name: Upload mobile remediation plan\n        uses: ${uploadArtifactActionRef}\n        with:\n          name: coding-tooling-mobile-remediation\n          path: .artifacts/coding-tooling/mobile-remediation-plan.json\n          if-no-files-found: error\n          retention-days: 14\n`;
}

export function mobileAnalysisOrchestrationSubjects(root: string): string[] {
  if (!existsSync(join(root, configName))) return [];
  return pagesWorkflows(root).length > 0 ? [configName] : [];
}

export function mobileAnalysisOrchestrationFindings({ root }: DetectorContext): RawFinding[] {
  if (!existsSync(join(root, configName))) return [];
  const pages = pagesWorkflows(root);
  if (pages.length === 0) return [];

  const parsed = parseConfig(root);
  const analyzerWorkflows = analysisWorkflowPaths(root);
  const evidence = [
    {
      kind: "config" as const,
      path: configName,
      detail: "mobile-analysis is explicitly configured",
    },
    ...pages.map((page) => ({
      kind: "config" as const,
      path: page.path,
      detail: `recognized Pages deployment workflow '${page.name}'`,
    })),
  ];

  if (!parsed.config) {
    return [
      {
        subject: {
          kind: "file" as const,
          key: configName,
          path: configName,
          description: "mobile-analysis configuration",
        },
        requirement: {
          kind: "wiring" as const,
          key: "mobile-analysis-orchestration",
          description:
            "mobile-analysis has a valid exact-revision deployment target and remediation continuation",
        },
        message: parsed.error ?? `${configName} is invalid`,
        evidence,
        relatedFiles: [configName, ...pages.map((page) => page.path)].sort(),
        verification: [["coding-tooling", "findings", "--json"]],
      },
    ];
  }

  if (
    analyzerWorkflows.some(({ content }) =>
      pages.some((page) => isCorrectlyWired(content, page, parsed.config!)),
    )
  ) {
    return [];
  }

  const relatedFiles = [
    configName,
    ...pages.map((page) => page.path),
    ...analyzerWorkflows.map((workflow) => workflow.path),
  ].sort();
  const shared = {
    subject: {
      kind: "file" as const,
      key: configName,
      path: configName,
      description: "mobile-analysis configuration",
    },
    requirement: {
      kind: "wiring" as const,
      key: "mobile-analysis-orchestration",
      description:
        "mobile-analysis analyzes the deployed Pages revision and feeds same-run evidence into read-only remediation planning",
    },
    evidence,
    relatedFiles,
    verification: [["coding-tooling", "findings", "--json"]],
  };

  if (pages.length !== 1) {
    return [
      {
        ...shared,
        message: `${configName} is applicable, but ${pages.length} Pages deployment workflows were found; coding-tooling will not guess which deployment should trigger mobile-analysis`,
      },
    ];
  }

  if (analyzerWorkflows.length > 0 || existsSync(join(root, generatedWorkflowPath))) {
    return [
      {
        ...shared,
        message:
          "mobile-analysis orchestration exists but does not match the configured target, exact deployed revision, same-run evidence provenance, or pinned remediation continuation contract",
      },
    ];
  }

  return [
    {
      ...shared,
      message: `${configName} is applicable to ${pages[0]!.path}, but no exact-revision mobile-analysis remediation continuation is wired`,
      scaffold: {
        kind: "create-file" as const,
        path: generatedWorkflowPath,
        content: generatedWorkflow(pages[0]!, parsed.config),
      },
    },
  ];
}
