import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix, walkFiles } from "./shared.ts";

const pagesDeploymentPattern =
  /(?:actions\/upload-pages-artifact|actions\/deploy-pages|deploy-pages\.ya?ml|pages:\s*write)/i;
const artifactProducerPattern =
  /(?:actions\/upload-pages-artifact|build-artifact\.ya?ml|artifact_paths\s*:)/i;
const exactArtifactConsumerPattern =
  /(?:prebuilt_artifact_(?:run_id|name|digest|source_sha|key|identity_digest|destination)|actions\/download-artifact)/i;
const deploymentJobPattern = /(?:actions\/deploy-pages|deploy-pages\.ya?ml)/i;
const runtimeVerificationPattern =
  /(?:playwright|e2e_command|test:e2e|browser(?:[-:_ ]?smoke)?|vite\s+preview|next\s+start)/i;
const buildInvocationPattern =
  /(?:\b(?:vite|next|nuxt|astro|vitepress|react-scripts|webpack)\b[^\n]*\bbuild\b|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build(?::[A-Za-z0-9:_-]+)?\b)/i;
const productionEnvironmentPattern =
  /\b((?:VITE|NEXT_PUBLIC|NUXT_PUBLIC|PUBLIC|REACT_APP)_[A-Z0-9_]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s\\]+)/g;
const publicEnvironmentKeyPattern =
  /\b((?:VITE|NEXT_PUBLIC|NUXT_PUBLIC|PUBLIC|REACT_APP)_[A-Z0-9_]+)\s*:/g;
const basePathPattern = /(?:^|\s)--base(?:\s+|=)(?:"[^"]+"|'[^']+'|[^\s\\]+)/g;

type CommandBlock = {
  command: string;
  lineIndex: number;
  effectiveIndent: number;
};

type WorkflowJob = {
  key: string;
  source: string;
  indent: number;
  needs: Set<string>;
};

type RuntimeSensitiveProducer = {
  job: WorkflowJob;
  signals: string[];
};

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

function indentation(line: string): number {
  return line.match(/^\s*/)![0].length;
}

function parseNeeds(source: string): Set<string> {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)needs:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1]!.length;
    const inline = match[2]!.trim();
    if (inline) {
      return new Set(
        inline
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean),
      );
    }

    const needs = new Set<string>();
    for (index += 1; index < lines.length; index += 1) {
      const next = lines[index]!;
      if (!next.trim()) continue;
      if (indentation(next) <= indent) break;
      const item = next.trim().match(/^-\s+['"]?([A-Za-z0-9_.-]+)['"]?\s*$/);
      if (item?.[1]) needs.add(item[1]);
    }
    return needs;
  }
  return new Set();
}

function workflowJobs(content: string): WorkflowJob[] {
  const lines = content.split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => /^\s*jobs:\s*(?:#.*)?$/.test(line));
  if (jobsLine < 0) return [];
  const jobsIndent = indentation(lines[jobsLine]!);
  let sectionEnd = lines.length;
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (indentation(line) <= jobsIndent) {
      sectionEnd = index;
      break;
    }
  }

  const candidates: Array<{ index: number; indent: number; key: string }> = [];
  for (let index = jobsLine + 1; index < sectionEnd; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (!match || match[1]!.length <= jobsIndent) continue;
    candidates.push({ index, indent: match[1]!.length, key: match[2]! });
  }
  const jobIndent = candidates.reduce(
    (minimum, candidate) => Math.min(minimum, candidate.indent),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(jobIndent)) return [];
  const starts = candidates.filter((candidate) => candidate.indent === jobIndent);
  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? sectionEnd;
    const source = lines.slice(start.index, end).join("\n");
    return { key: start.key, source, indent: start.indent, needs: parseNeeds(source) };
  });
}

function commandBlocks(content: string): CommandBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: CommandBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)(-\s+)?(?:run|build_command):\s*(.*)$/);
    if (!match) continue;
    const indent = match[1]!.length;
    const effectiveIndent = indent + (match[2] ? 2 : 0);
    const inline = match[3]!.trim();
    const lineIndex = index;
    if (inline && inline !== "|" && inline !== ">") {
      blocks.push({ command: inline, lineIndex, effectiveIndent });
      continue;
    }

    const block: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const next = lines[index]!;
      if (!next.trim()) {
        block.push("");
        continue;
      }
      if (indentation(next) <= indent) {
        index -= 1;
        break;
      }
      block.push(next.trim());
    }
    blocks.push({ command: block.join("\n"), lineIndex, effectiveIndent });
  }
  return blocks;
}

function environmentKeysFromMap(lines: string[], envIndex: number): string[] {
  const line = lines[envIndex]!;
  const match = line.match(/^(\s*)(?:-\s+)?env:\s*(.*)$/);
  if (!match) return [];
  const envIndent = match[1]!.length;
  const inline = match[2]!.trim();
  if (inline.startsWith("{") && inline.endsWith("}")) {
    return [...inline.matchAll(publicEnvironmentKeyPattern)]
      .map((entry) => entry[1])
      .filter((entry): entry is string => Boolean(entry));
  }

  const keys: string[] = [];
  for (let index = envIndex + 1; index < lines.length; index += 1) {
    const next = lines[index]!;
    if (!next.trim()) continue;
    if (indentation(next) <= envIndent) break;
    for (const key of next.matchAll(publicEnvironmentKeyPattern)) {
      if (key[1]) keys.push(key[1]);
    }
  }
  return keys;
}

function directEnvironmentKeys(source: string, parentIndent: number): string[] {
  const lines = source.split(/\r?\n/);
  const childIndents = lines
    .slice(1)
    .filter((line) => line.trim() && indentation(line) > parentIndent)
    .map(indentation);
  if (childIndents.length === 0) return [];
  const directIndent = Math.min(...childIndents);
  const keys = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (indentation(line) !== directIndent || !/^\s*env:/.test(line)) continue;
    for (const key of environmentKeysFromMap(lines, index)) keys.add(key);
  }
  return [...keys].sort();
}

function topLevelEnvironmentKeys(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const keys = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (indentation(line) !== 0 || !line.startsWith("env:")) continue;
    for (const key of environmentKeysFromMap(lines, index)) keys.add(key);
  }
  return [...keys].sort();
}

function stepEnvironmentKeys(source: string, command: CommandBlock): string[] {
  const lines = source.split(/\r?\n/);
  let stepStart = -1;
  let stepIndent = -1;
  for (let index = command.lineIndex; index >= 0; index -= 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)-\s+/);
    if (!match || match[1]!.length >= command.effectiveIndent) continue;
    stepStart = index;
    stepIndent = match[1]!.length;
    break;
  }
  if (stepStart < 0) return [];

  let stepEnd = lines.length;
  for (let index = stepStart + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (indentation(line) <= stepIndent) {
      stepEnd = index;
      break;
    }
  }
  if (command.lineIndex >= stepEnd) return [];

  const keys = new Set<string>();
  for (let index = stepStart; index < stepEnd; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^(\s*)env:/);
    if (!match || match[1]!.length !== command.effectiveIndent) continue;
    for (const key of environmentKeysFromMap(lines, index)) keys.add(key);
  }
  return [...keys].sort();
}

function runtimeSensitiveBuildSignals(
  job: WorkflowJob,
  workflowEnvironmentKeys: readonly string[],
): string[] {
  const signals = new Set<string>();
  const jobEnvironmentKeys = directEnvironmentKeys(job.source, job.indent);
  for (const command of commandBlocks(job.source)) {
    if (!buildInvocationPattern.test(command.command)) continue;
    for (const match of command.command.matchAll(productionEnvironmentPattern)) {
      if (match[1]) signals.add(`production environment ${match[1]}`);
    }
    for (const match of command.command.matchAll(basePathPattern)) {
      signals.add(`production ${match[0]!.trim()}`);
    }
    for (const key of workflowEnvironmentKeys) signals.add(`production environment ${key}`);
    for (const key of jobEnvironmentKeys) signals.add(`production environment ${key}`);
    for (const key of stepEnvironmentKeys(job.source, command)) {
      signals.add(`production environment ${key}`);
    }
  }
  return [...signals].sort();
}

function runtimeSensitiveProducers(content: string): RuntimeSensitiveProducer[] {
  const workflowEnvironmentKeys = topLevelEnvironmentKeys(content);
  return workflowJobs(content).flatMap((job) => {
    if (!artifactProducerPattern.test(job.source)) return [];
    const signals = runtimeSensitiveBuildSignals(job, workflowEnvironmentKeys);
    return signals.length > 0 ? [{ job, signals }] : [];
  });
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referencesProducerOutputs(source: string, producerKey: string): boolean {
  return new RegExp(`\\bneeds\\.${escaped(producerKey)}\\.outputs\\.`).test(source);
}

function consumesProducerArtifact(job: WorkflowJob, producerKey: string): boolean {
  return (
    job.needs.has(producerKey) &&
    exactArtifactConsumerPattern.test(job.source) &&
    referencesProducerOutputs(job.source, producerKey)
  );
}

function hasExactArtifactRuntimeVerification(content: string): boolean {
  const jobs = workflowJobs(content);
  const producers = runtimeSensitiveProducers(content);
  return producers.some(({ job: producer }) => {
    const verifiers = jobs.filter(
      (job) =>
        job.key !== producer.key &&
        runtimeVerificationPattern.test(job.source) &&
        consumesProducerArtifact(job, producer.key),
    );
    return verifiers.some((verifier) =>
      jobs.some(
        (deploy) =>
          deploy.key !== producer.key &&
          deploy.key !== verifier.key &&
          deploymentJobPattern.test(deploy.source) &&
          deploy.needs.has(verifier.key) &&
          consumesProducerArtifact(deploy, producer.key),
      ),
    );
  });
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
    const producers = runtimeSensitiveProducers(content);
    const signals = [...new Set(producers.flatMap((producer) => producer.signals))].sort();
    if (signals.length === 0) return [];
    return [{ path, workflowPath: relativePosix(root, path), content, signals }];
  });
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
        message: `${workflowPath} builds a runtime-sensitive Pages artifact but exposes no proven producer → runtime-verifier → deploy chain for that artifact`,
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
