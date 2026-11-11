import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { agentCapabilitySourcePaths, parseFrontmatter } from "./agent-capabilities.ts";
import type { ResultEnvelope } from "./model.ts";

export type AgentEvalCase = {
  id: string;
  path: string;
  digest: string;
  capabilities: string[];
  critical: boolean;
  task: string;
  given: string;
  requiredObservations: string[];
  forbiddenBehavior: string[];
  acceptableOutcomes: string[];
};

type ObservationStatus = "met" | "not-met" | "not-exercised";
type RunVerdict = "passed" | "failed";

type JudgedRun = {
  caseId: string;
  caseDigest: string;
  runner?: string;
  observations: Array<{ index: number; status: ObservationStatus; evidence: string }>;
  forbidden: Array<{ index: number; occurred: boolean; evidence: string }>;
  outcome: { index: number; evidence: string } | null;
};

const SECTIONS = [
  "Task",
  "Given",
  "Required observations",
  "Forbidden behavior",
  "Acceptable outcomes",
] as const;
type SectionName = (typeof SECTIONS)[number];

function parseSections(path: string, source: string): Record<SectionName, string> {
  const body = source.slice(source.indexOf("\n---", 3) + 4);
  const headings: Array<{ name: string; start: number; end: number }> = [];
  for (const match of body.matchAll(/^## (.+)$/gm)) {
    const start = match.index;
    headings.push({ name: match[1].trim(), start, end: start + match[0].length });
  }
  const names = headings.map((heading) => heading.name);
  if (names.join("\n") !== SECTIONS.join("\n")) {
    throw new Error(
      `${path}: sections must be exactly ${SECTIONS.join(", ")}; got ${names.join(", ")}`,
    );
  }
  const sections = {} as Record<SectionName, string>;
  headings.forEach((heading, index) => {
    const text = body.slice(heading.end, headings[index + 1]?.start ?? body.length).trim();
    if (text === "") throw new Error(`${path}: section ${heading.name} is empty`);
    sections[heading.name as SectionName] = text;
  });
  return sections;
}

function parseBullets(path: string, section: string, text: string): string[] {
  const bullets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("- ")) throw new Error(`${path}: section ${section} must be a flat list`);
    bullets.push(line.slice(2).trim());
  }
  return bullets;
}

function parseOutcomes(path: string, text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.some((line) => line.startsWith("- "))) {
    return parseBullets(path, "Acceptable outcomes", text);
  }
  return [lines.join(" ").trim()];
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "")
      throw new Error(`${label} must contain strings`);
    return entry;
  });
}

function parseCase(root: string, name: string): AgentEvalCase {
  const relative = join("evals", "cases", name);
  const absolute = join(root, relative);
  const source = readFileSync(absolute, "utf8");
  const frontmatter = parseFrontmatter(absolute);
  const unknown = Object.keys(frontmatter).filter(
    (key) => !["id", "capabilities", "critical"].includes(key),
  );
  if (unknown.length > 0)
    throw new Error(`${relative}: unknown frontmatter: ${unknown.join(", ")}`);
  const expectedId = `eval/${basename(name, ".md")}`;
  if (frontmatter.id !== expectedId) throw new Error(`${relative}: id must be ${expectedId}`);
  if (typeof frontmatter.critical !== "boolean")
    throw new Error(`${relative}: critical must be a boolean`);
  const sections = parseSections(relative, source);
  return {
    id: expectedId,
    path: relative,
    digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    capabilities: stringList(frontmatter.capabilities, `${relative}: capabilities`),
    critical: frontmatter.critical,
    task: sections.Task,
    given: sections.Given,
    requiredObservations: parseBullets(
      relative,
      "Required observations",
      sections["Required observations"],
    ),
    forbiddenBehavior: parseBullets(relative, "Forbidden behavior", sections["Forbidden behavior"]),
    acceptableOutcomes: parseOutcomes(relative, sections["Acceptable outcomes"]),
  };
}

export function loadAgentEvalCases(root: string): AgentEvalCase[] {
  const directory = join(root, "evals", "cases");
  if (!existsSync(directory)) throw new Error(`${root}: evals/cases not found`);
  const cases = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseCase(root, name));
  if (cases.length === 0) throw new Error(`${root}: no behavioral cases found`);
  const sources = agentCapabilitySourcePaths(root);
  for (const evalCase of cases) {
    for (const capability of evalCase.capabilities) {
      if (!sources.has(capability)) {
        throw new Error(`${evalCase.path}: unknown capability ${capability}`);
      }
    }
  }
  return cases;
}

function selectCase(cases: AgentEvalCase[], caseId: string | undefined): AgentEvalCase {
  if (!caseId) throw new Error("--case <id> is required");
  const found = cases.find((evalCase) => evalCase.id === caseId);
  if (!found) throw new Error(`unknown case ${caseId}`);
  return found;
}

function requireIndex(value: unknown, length: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= length) {
    throw new Error(`${label} must be an index below ${length}`);
  }
  return value as number;
}

function requireEvidence(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} needs evidence`);
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireComplete(indexes: number[], length: number, label: string): void {
  const seen = new Set(indexes);
  if (seen.size !== indexes.length) throw new Error(`${label} repeats an index`);
  if (seen.size !== length) throw new Error(`${label} must judge all ${length} entries`);
}

function parseRun(
  value: unknown,
  index: number,
  cases: AgentEvalCase[],
): { run: JudgedRun; evalCase: AgentEvalCase } {
  const label = `runs[${index}]`;
  const raw = requireObject(value, label);
  const evalCase = selectCase(cases, raw.caseId as string | undefined);
  if (raw.caseDigest !== evalCase.digest) {
    throw new Error(`${label}: judged a different revision of ${evalCase.id}`);
  }
  if (!Array.isArray(raw.observations) || !Array.isArray(raw.forbidden)) {
    throw new Error(`${label}: observations and forbidden must be arrays`);
  }
  const observations = raw.observations.map((entry, position) => {
    const item = requireObject(entry, `${label}.observations[${position}]`);
    if (item.status !== "met" && item.status !== "not-met" && item.status !== "not-exercised") {
      throw new Error(`${label}.observations[${position}].status is invalid`);
    }
    return {
      index: requireIndex(
        item.index,
        evalCase.requiredObservations.length,
        `${label}.observations[${position}].index`,
      ),
      status: item.status as ObservationStatus,
      evidence: requireEvidence(item.evidence, `${label}.observations[${position}]`),
    };
  });
  const forbidden = raw.forbidden.map((entry, position) => {
    const item = requireObject(entry, `${label}.forbidden[${position}]`);
    if (typeof item.occurred !== "boolean")
      throw new Error(`${label}.forbidden[${position}].occurred must be a boolean`);
    return {
      index: requireIndex(
        item.index,
        evalCase.forbiddenBehavior.length,
        `${label}.forbidden[${position}].index`,
      ),
      occurred: item.occurred,
      evidence: requireEvidence(item.evidence, `${label}.forbidden[${position}]`),
    };
  });
  requireComplete(
    observations.map((item) => item.index),
    evalCase.requiredObservations.length,
    `${label}.observations`,
  );
  requireComplete(
    forbidden.map((item) => item.index),
    evalCase.forbiddenBehavior.length,
    `${label}.forbidden`,
  );
  let outcome: JudgedRun["outcome"] = null;
  if (raw.outcome !== null) {
    const item = requireObject(raw.outcome, `${label}.outcome`);
    outcome = {
      index: requireIndex(item.index, evalCase.acceptableOutcomes.length, `${label}.outcome.index`),
      evidence: requireEvidence(item.evidence, `${label}.outcome`),
    };
  }
  const run: JudgedRun = {
    caseId: evalCase.id,
    caseDigest: evalCase.digest,
    observations,
    forbidden,
    outcome,
  };
  if (typeof raw.runner === "string") run.runner = raw.runner;
  return { run, evalCase };
}

export function reportAgentEvalResults(
  cases: AgentEvalCase[],
  results: unknown,
): Record<string, unknown> {
  const document = requireObject(results, "results");
  if (document.schemaVersion !== 1) throw new Error("results.schemaVersion must be 1");
  if (!Array.isArray(document.runs)) throw new Error("results.runs must be an array");
  const judged = document.runs.map((run, index) => {
    const { run: parsed, evalCase } = parseRun(run, index, cases);
    const notMet = parsed.observations
      .filter((item) => item.status === "not-met")
      .map((item) => evalCase.requiredObservations[item.index]);
    const notExercised = parsed.observations
      .filter((item) => item.status === "not-exercised")
      .map((item) => evalCase.requiredObservations[item.index]);
    const occurred = parsed.forbidden
      .filter((item) => item.occurred)
      .map((item) => evalCase.forbiddenBehavior[item.index]);
    const verdict: RunVerdict =
      notMet.length === 0 && occurred.length === 0 && parsed.outcome !== null ? "passed" : "failed";
    return {
      caseId: parsed.caseId,
      runner: parsed.runner,
      critical: evalCase.critical,
      verdict,
      notMet,
      notExercised,
      forbiddenOccurred: occurred,
      outcome: parsed.outcome === null ? null : evalCase.acceptableOutcomes[parsed.outcome.index],
    };
  });
  const ran = new Set(judged.map((run) => run.caseId));
  const failed = judged.filter((run) => run.verdict === "failed");
  return {
    runs: judged,
    summary: {
      runs: judged.length,
      passed: judged.length - failed.length,
      failed: failed.length,
      criticalFailures: [...new Set(failed.filter((run) => run.critical).map((run) => run.caseId))],
      notRun: cases.filter((evalCase) => !ran.has(evalCase.id)).map((evalCase) => evalCase.id),
    },
  };
}

export function agentEvalsCommand(
  root: string,
  action: string,
  options: { caseId?: string; resultsPath?: string } = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = performance.now();
  const envelope = (
    status: "passed" | "failed",
    data: Record<string, unknown>,
    message?: string,
  ) => ({
    schemaVersion: 1 as const,
    operation: "agent-evals" as const,
    status,
    durationMs: Math.round(performance.now() - started),
    data,
    diagnostics: message ? [{ message }] : [],
  });
  try {
    const cases = loadAgentEvalCases(root);
    if (action === "validate") {
      return envelope("passed", {
        cases: cases.length,
        critical: cases.filter((evalCase) => evalCase.critical).length,
      });
    }
    if (action === "brief") {
      const evalCase = selectCase(cases, options.caseId);
      const sources = agentCapabilitySourcePaths(root);
      return envelope("passed", {
        caseId: evalCase.id,
        capabilities: evalCase.capabilities.map((id) => ({ id, source: sources.get(id) })),
        task: evalCase.task,
        given: evalCase.given,
      });
    }
    if (action === "criteria") {
      const evalCase = selectCase(cases, options.caseId);
      return envelope("passed", {
        caseId: evalCase.id,
        caseDigest: evalCase.digest,
        critical: evalCase.critical,
        requiredObservations: evalCase.requiredObservations,
        forbiddenBehavior: evalCase.forbiddenBehavior,
        acceptableOutcomes: evalCase.acceptableOutcomes,
      });
    }
    if (action === "report") {
      if (!options.resultsPath) throw new Error("--results <path> is required");
      const data = reportAgentEvalResults(
        cases,
        JSON.parse(readFileSync(options.resultsPath, "utf8")),
      );
      const failed = (data.summary as { failed: number }).failed;
      return envelope(failed === 0 ? "passed" : "failed", data);
    }
    throw new Error("expected agent-evals action: validate, brief, criteria, or report");
  } catch (error) {
    return envelope("failed", {}, error instanceof Error ? error.message : String(error));
  }
}
