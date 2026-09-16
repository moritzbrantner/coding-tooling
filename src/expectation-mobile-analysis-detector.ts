import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix, walkFiles } from "./shared.ts";

const configName = "mobile-analysis.config.json";
const generatedWorkflowPath = ".github/workflows/mobile-analysis.yml";
const mobileAnalysisWorkflowRef =
  "moritzbrantner/mobile-analysis/.github/workflows/analyze.yml@bf0b80f0b62b429702c0657a8d4a347243a6e4e0";
const pagesDeploymentPattern =
  /(?:actions\/upload-pages-artifact|actions\/deploy-pages|deploy-pages\.ya?ml|pages:\s*write)/i;
const mobileAnalysisCallPattern =
  /moritzbrantner\/mobile-analysis\/\.github\/workflows\/analyze\.yml@[0-9a-f]{40}/i;

type PagesWorkflow = {
  path: string;
  name: string;
  content: string;
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
    return [{ path: workflowPath, name: workflowName(content, workflowPath), content }];
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
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
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
        targetUrl: baseUrl,
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

function referencesWorkflow(content: string, page: PagesWorkflow): boolean {
  return content.includes("workflow_run:") && content.includes(page.name);
}

function configuredAnalyzerWorkflow(
  workflows: PagesWorkflow[],
  config: MobileAnalysisConfig,
): string | undefined {
  for (const path of workflowFiles(workflows.length > 0 ? join(workflows[0]!.path, "..") : "")) {
    void path;
  }
  return undefined;
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

function isCorrectlyWired(
  content: string,
  page: PagesWorkflow,
  config: MobileAnalysisConfig,
): boolean {
  return (
    mobileAnalysisCallPattern.test(content) &&
    referencesWorkflow(content, page) &&
    scalar(content, "target_url") === config.targetUrl &&
    scalar(content, "config_path") === configName &&
    scalar(content, "run_unlighthouse") === String(config.runUnlighthouse)
  );
}

function generatedWorkflow(page: PagesWorkflow, config: MobileAnalysisConfig): string {
  return `name: Mobile analysis\n\non:\n  workflow_dispatch:\n  workflow_run:\n    workflows:\n      - ${yamlScalar(page.name)}\n    types:\n      - completed\n\npermissions:\n  contents: read\n\njobs:\n  analyze:\n    if: \${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}\n    uses: ${mobileAnalysisWorkflowRef}\n    with:\n      target_url: ${yamlScalar(config.targetUrl)}\n      config_path: ${configName}\n      run_unlighthouse: ${String(config.runUnlighthouse)}\n`;
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
    { kind: "config" as const, path: configName, detail: "mobile-analysis is explicitly configured" },
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
          description: "mobile-analysis has a valid post-deployment target and orchestration workflow",
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
      description: "mobile-analysis runs automatically after the configured Pages deployment",
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
        message: "mobile-analysis orchestration exists but does not match the configured target, Pages trigger, or exact reusable-workflow contract",
      },
    ];
  }

  return [
    {
      ...shared,
      message: `${configName} is applicable to ${pages[0]!.path}, but no post-deployment mobile-analysis workflow is wired`,
      scaffold: {
        kind: "create-file" as const,
        path: generatedWorkflowPath,
        content: generatedWorkflow(pages[0]!, parsed.config),
      },
    },
  ];
}
