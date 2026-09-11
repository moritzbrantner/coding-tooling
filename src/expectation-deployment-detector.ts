import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix, walkFiles } from "./shared.ts";

const pagesDeploymentPattern =
  /(?:actions\/upload-pages-artifact|actions\/deploy-pages|deploy-pages\.ya?ml|pages:\s*write)/i;
const exactArtifactConsumerPattern =
  /(?:prebuilt_artifact_(?:run_id|name|digest|source_sha|key|identity_digest|destination)|actions\/download-artifact)/i;
const runtimeVerificationPattern =
  /(?:playwright|e2e_command|test:e2e|browser(?:[-:_ ]?smoke)?|vite\s+preview|next\s+start)/i;
const buildInvocationPattern =
  /(?:\b(?:vite|next|nuxt|astro|vitepress|react-scripts|webpack)\b[^\n]*\bbuild\b|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build(?::[A-Za-z0-9:_-]+)?\b)/i;
const productionEnvironmentPattern =
  /\b((?:VITE|NEXT_PUBLIC|NUXT_PUBLIC|PUBLIC|REACT_APP)_[A-Z0-9_]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s\\]+)/g;
const basePathPattern = /(?:^|\s)--base(?:\s+|=)(?:"[^"]+"|'[^']+'|[^\s\\]+)/g;

type RuntimeSensitivePagesWorkflow = {
  path: string;
  workflowPath: string;
  content: string;
  signals: string[];
};

function workflowFiles(root: string): string[] {
  return walkFiles(join(root, ".github", "workflows"), 2)
    .filter((path) => [".yml", ".yaml"].includes(extname(path)))
    .sort();
}

function commandBlocks(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)(?:-\s+)?(?:run|build_command):\s*(.*)$/);
    if (!match) continue;
    const indent = match[1]!.length;
    const inline = match[2]!.trim();
    if (inline && inline !== "|" && inline !== ">") {
      blocks.push(inline);
      continue;
    }

    const block: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const next = lines[index]!;
      if (!next.trim()) {
        block.push("");
        continue;
      }
      const nextIndent = next.match(/^\s*/)![0].length;
      if (nextIndent <= indent) {
        index -= 1;
        break;
      }
      block.push(next.trim());
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function runtimeSensitiveBuildSignals(content: string): string[] {
  const signals = new Set<string>();
  for (const command of commandBlocks(content)) {
    if (!buildInvocationPattern.test(command)) continue;
    for (const match of command.matchAll(productionEnvironmentPattern)) {
      if (match[1]) signals.add(`production environment ${match[1]}`);
    }
    for (const match of command.matchAll(basePathPattern)) {
      signals.add(`production ${match[0]!.trim()}`);
    }
  }
  return [...signals].sort();
}

function runtimeSensitivePagesWorkflows(root: string): RuntimeSensitivePagesWorkflow[] {
  return workflowFiles(root).flatMap((path) => {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return [];
    }

    if (!pagesDeploymentPattern.test(content)) return [];
    const signals = runtimeSensitiveBuildSignals(content);
    if (signals.length === 0) return [];
    return [{ path, workflowPath: relativePosix(root, path), content, signals }];
  });
}

function hasExactArtifactRuntimeVerification(content: string): boolean {
  return exactArtifactConsumerPattern.test(content) && runtimeVerificationPattern.test(content);
}

export function deploymentRuntimeParitySubjects(root: string): string[] {
  return runtimeSensitivePagesWorkflows(root).map((workflow) => workflow.workflowPath);
}

export function deploymentRuntimeParityFindings({ root }: DetectorContext): RawFinding[] {
  return runtimeSensitivePagesWorkflows(root).flatMap(({ content, signals, workflowPath }) => {
    if (hasExactArtifactRuntimeVerification(content)) return [];

    return [
      {
        subject: {
          kind: "file" as const,
          key: workflowPath,
          path: workflowPath,
          description: `Deployment workflow ${workflowPath}`,
        },
        requirement: {
          kind: "check" as const,
          key: "deployment-runtime-parity",
          description:
            "runtime validation consumes the exact production deployment artifact before deployment",
        },
        message: `${workflowPath} builds a runtime-sensitive Pages artifact but exposes no browser/runtime verification of that exact artifact`,
        evidence: signals.map((detail) => ({
          kind: "file" as const,
          path: workflowPath,
          detail,
        })),
        relatedFiles: [workflowPath],
        verification: [],
      },
    ];
  });
}
