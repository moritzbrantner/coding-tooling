import { createHash } from "node:crypto";

/** The failure classes of shared convention AGENT-011. */
export const failureCategories = [
  "candidate-regression",
  "pre-existing-baseline",
  "test-harness",
  "environment-infrastructure",
  "noisy-performance",
  "unavailable-unknown",
] as const;

export type FailureCategory = (typeof failureCategories)[number];

export const failureAnnotationsSchemaVersion = "coding-tooling/ci-failure-annotations/v1";

/** A maintainer's attribution of one run, or of every failure with one fingerprint. */
export type FailureAnnotation = {
  runId?: number;
  attempt?: number;
  fingerprint?: string;
  category: FailureCategory;
  annotator: string;
  reference?: string;
  note?: string;
};

export type ApiStep = {
  name: string;
  number?: number;
  status?: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type ApiJob = {
  id: number;
  name: string;
  html_url?: string;
  status?: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: ApiStep[];
};

export type LogAccess = "read" | "unavailable" | "not-applicable";

export type FailureDescription = {
  job: { id: number; name: string; url: string | null } | null;
  step: { name: string; number: number | null } | null;
  zeroStep: boolean;
  fingerprint: { id: string; text: string };
  signal: { text: string; source: "check-annotation" | "job-log" } | null;
  hypothesis: FailureCategory | null;
  /** GitHub itself reported that the job never ran, so no repository code was involved. */
  platformRefusal: boolean;
  logs: LogAccess;
};

export type EvidenceKind = "same-head-retry" | "base-comparison" | "logs" | "maintainer-annotation";

export type AttributionEvidence = {
  kind: EvidenceKind;
  outcome: "supports" | "neutral" | "unavailable";
  detail: string;
  sourceRunIds: number[];
};

export type RetryOutcome =
  | { state: "green"; runIds: number[] }
  | { state: "reproduced"; runIds: number[] }
  | { state: "none" };

export type BaseOutcome =
  | { state: "red-same"; runId: number }
  | { state: "red-different"; runId: number }
  | { state: "green"; runId: number }
  | { state: "unavailable"; reason: string };

export type Attribution = {
  status: "confirmed" | "hypothesis" | "unclassified";
  /** The supported category; `unavailable-unknown` until something confirms one. */
  category: FailureCategory;
  hypothesis: FailureCategory | null;
  annotation: FailureAnnotation | null;
  evidence: AttributionEvidence[];
};

const platformRefusal = /recent account payments have failed|spending limit needs to be increased/i;

// A signal only proposes a category. It is the reason for the hypothesis, so it cannot also be the
// evidence that confirms it.
const signalRules: { category: FailureCategory; pattern: RegExp; context?: RegExp }[] = [
  {
    category: "environment-infrastructure",
    pattern:
      /returned error: 50[234]\b|\bhttp(?!s?:\/\/)\b.{0,30}\b50[234]\b|\b50[234] (?:gateway|bad gateway|service unavailable)|gateway time-?out|econnreset|eai_again|could not resolve host|tls handshake timeout|connection reset by peer|lost communication with the server/i,
  },
  {
    category: "noisy-performance",
    pattern:
      /\bvariation\b|\bvariance\b|\bnoisy\b|\bunstable\b|\bratio\b.*\d|\bthreshold\b.*\d|\d.*\bthreshold\b|regress.*\d%/i,
    context: /bench|perf/i,
  },
  {
    category: "test-harness",
    pattern:
      /(?:readiness|\bready\b).*(?:timed? ?out|deadline)|(?:timed? ?out|deadline).*(?:readiness|\bready\b)|timed out \d+ ?ms waiting|timeout \d+ ?ms exceeded|page\.goto: timeout|net::err_connection_refused/i,
  },
];

/** Removes run-specific values so one failure mode keeps one fingerprint across runs. */
export function normalizeFailureText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/(https?:\/\/[^/\s]+)\S*/g, "$1")
    .replace(/(?:\/tmp|\/home\/runner)\/\S*/g, "<path>")
    .replace(/\b[0-9a-f]*\d[0-9a-f]*[a-f][0-9a-f]*\b|\b[a-f]+\d[0-9a-f]*\b/g, (match) =>
      match.length >= 7 ? "<hex>" : match,
    )
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const genericError = /^process completed with exit code \d+\.?$/i;

/** The job log lines a failed step wrote, by the timestamp prefix GitHub adds to each line. */
export function failedStepLines(log: string, step: ApiStep | null): string[] {
  const timed = log.split(/\r?\n/).flatMap((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z (.*)$/.exec(line);
    return match ? [{ at: Date.parse(`${match[1]}Z`), text: match[2]! }] : [];
  });
  const from = step?.started_at ? Date.parse(step.started_at) : undefined;
  const to = step?.completed_at ? Date.parse(step.completed_at) + 1000 : undefined;
  const inStep = timed.filter(
    (line) => (from === undefined || line.at >= from) && (to === undefined || line.at <= to),
  );
  return (inStep.length > 0 ? inStep : timed).map((line) => line.text);
}

// A step's log also lists the tests that passed, whose titles can read like any failure.
const passingLine = /^\s*(?:[✓✔√]|ok\b|pass(?:ed)?\b)/i;
const failingLine = /^\s*(?:[✘✗×]|FAIL\b|\d+\) \[)/;

function findSignal(
  lines: string[],
  context: string,
): { line: string; category: FailureCategory } | undefined {
  for (const rule of signalRules) {
    const line = lines.find(
      (candidate) =>
        !passingLine.test(candidate) &&
        rule.pattern.test(candidate) &&
        (!rule.context || rule.context.test(context) || rule.context.test(candidate)),
    );
    if (line !== undefined) return { line, category: rule.category };
  }
  return undefined;
}

const errorText = (line: string) => line.replace(/^##\[error\]/, "").trim();

/** Describes one failed attempt from its first failing job, preferring structured annotations. */
export function describeFailure(input: {
  workflowPath: string;
  conclusion: string | null;
  job: ApiJob | null;
  step: ApiStep | null;
  annotations: string[];
  logLines: string[];
  logs: LogAccess;
}): FailureDescription {
  const { job, step } = input;
  const zeroStep =
    job !== null && (job.steps ?? []).every((candidate) => candidate.started_at === null);
  const context = `${job?.name ?? ""} ${step?.name ?? ""}`;
  const fromAnnotations = findSignal(input.annotations, context);
  const fromLogs = fromAnnotations ? undefined : findSignal(input.logLines.map(errorText), context);
  const usefulAnnotation = input.annotations.find((text) => !genericError.test(text.trim()));
  const usefulLog =
    input.logLines
      .filter((line) => line.startsWith("##[error]"))
      .map(errorText)
      .find((text) => !genericError.test(text)) ??
    input.logLines.find((line) => failingLine.test(line))?.trim();
  const refused = zeroStep && input.annotations.some((text) => platformRefusal.test(text));
  const signal = fromAnnotations
    ? { text: fromAnnotations.line, source: "check-annotation" as const }
    : fromLogs
      ? { text: fromLogs.line, source: "job-log" as const }
      : usefulAnnotation !== undefined
        ? { text: usefulAnnotation, source: "check-annotation" as const }
        : usefulLog !== undefined
          ? { text: usefulLog, source: "job-log" as const }
          : null;
  const structural = job === null ? (input.conclusion ?? "no-jobs") : zeroStep ? "zero-step" : "";
  const text = [
    normalizeFailureText(job?.name ?? "no job"),
    normalizeFailureText(step?.name ?? "no step"),
    normalizeFailureText(signal?.text ?? structural),
  ].join(" | ");
  return {
    job: job ? { id: job.id, name: job.name, url: job.html_url ?? null } : null,
    step: step ? { name: step.name, number: step.number ?? null } : null,
    zeroStep,
    fingerprint: {
      id: createHash("sha256").update(`${input.workflowPath}\n${text}`).digest("hex").slice(0, 16),
      text,
    },
    signal,
    hypothesis:
      fromAnnotations?.category ??
      fromLogs?.category ??
      (zeroStep || refused ? "environment-infrastructure" : null),
    platformRefusal: refused,
    logs: input.logs,
  };
}

// What can confirm each proposed category. A green rerun is not enough for a timing failure: a race
// in the candidate passes on retry too, so a harness defect needs the failure on unchanged code.
const confirmedBy: Record<FailureCategory, { retryGreen: boolean; baseRed: boolean }> = {
  "environment-infrastructure": { retryGreen: true, baseRed: true },
  "noisy-performance": { retryGreen: true, baseRed: true },
  "test-harness": { retryGreen: false, baseRed: true },
  "pre-existing-baseline": { retryGreen: false, baseRed: true },
  "candidate-regression": { retryGreen: false, baseRed: false },
  "unavailable-unknown": { retryGreen: false, baseRed: false },
};

/** Applies the evidence to the proposed category; without support it stays a hypothesis. */
export function attributeFailure(input: {
  description: FailureDescription;
  retry: RetryOutcome;
  base: BaseOutcome;
  annotation: FailureAnnotation | null;
}): Attribution {
  const { description, retry, base, annotation } = input;
  const hypothesis =
    description.hypothesis ??
    (base.state === "red-same"
      ? "pre-existing-baseline"
      : base.state === "green"
        ? "candidate-regression"
        : null);
  const rule = hypothesis ? confirmedBy[hypothesis] : undefined;
  const retrySupports = retry.state === "green" && rule?.retryGreen === true;
  const baseSupports = base.state === "red-same" && rule?.baseRed === true;
  // Without failure text, a repeat may be the same outage twice rather than the same defect.
  const reproducedRegression =
    hypothesis === "candidate-regression" &&
    base.state === "green" &&
    retry.state === "reproduced" &&
    description.signal !== null;
  const evidence: AttributionEvidence[] = [];
  if (retry.state === "green") {
    evidence.push({
      kind: "same-head-retry",
      outcome: retrySupports ? "supports" : "neutral",
      detail: retrySupports
        ? "A later attempt on the same head passed."
        : "A later attempt on the same head passed; that alone does not establish a cause.",
      sourceRunIds: retry.runIds,
    });
  } else if (retry.state === "reproduced") {
    evidence.push({
      kind: "same-head-retry",
      outcome: reproducedRegression ? "supports" : "neutral",
      detail: "Another attempt on the same head failed with the same fingerprint.",
      sourceRunIds: retry.runIds,
    });
  }
  if (base.state === "unavailable") {
    evidence.push({
      kind: "base-comparison",
      outcome: "unavailable",
      detail: base.reason,
      sourceRunIds: [],
    });
  } else {
    const details = {
      "red-same": "The default branch was already failing with the same fingerprint.",
      "red-different": "The default branch was failing with a different fingerprint.",
      green: "The default branch last passed before this head started.",
    };
    evidence.push({
      kind: "base-comparison",
      outcome:
        baseSupports || (base.state === "green" && reproducedRegression) ? "supports" : "neutral",
      detail: details[base.state],
      sourceRunIds: [base.runId],
    });
  }
  if (description.logs === "unavailable") {
    evidence.push({
      kind: "logs",
      outcome: "unavailable",
      detail: "The failing job's log could not be read.",
      sourceRunIds: [],
    });
  }
  if (description.platformRefusal) {
    evidence.push({
      kind: "logs",
      outcome: "supports",
      detail: "No step ran and GitHub reported an account billing refusal for the job.",
      sourceRunIds: [],
    });
  }
  if (annotation) {
    evidence.push({
      kind: "maintainer-annotation",
      outcome: "supports",
      detail: `Annotated by ${annotation.annotator}${annotation.reference ? ` (${annotation.reference})` : ""}.`,
      sourceRunIds: annotation.runId === undefined ? [] : [annotation.runId],
    });
    return annotation.category === "unavailable-unknown"
      ? { status: "unclassified", category: annotation.category, hypothesis, annotation, evidence }
      : { status: "confirmed", category: annotation.category, hypothesis, annotation, evidence };
  }
  if (hypothesis === null)
    return {
      status: "unclassified",
      category: "unavailable-unknown",
      hypothesis,
      annotation,
      evidence,
    };
  const confirmed =
    retrySupports ||
    baseSupports ||
    reproducedRegression ||
    (description.platformRefusal && hypothesis === "environment-infrastructure");
  return confirmed
    ? { status: "confirmed", category: hypothesis, hypothesis, annotation, evidence }
    : { status: "hypothesis", category: "unavailable-unknown", hypothesis, annotation, evidence };
}

/** Validates a maintainer annotation file; throws with the offending entry. */
export function parseFailureAnnotations(value: unknown): FailureAnnotation[] {
  const file = value as { schemaVersion?: unknown; annotations?: unknown } | null;
  if (file?.schemaVersion !== failureAnnotationsSchemaVersion || !Array.isArray(file.annotations))
    throw new Error(`expected schemaVersion ${failureAnnotationsSchemaVersion} and annotations[]`);
  return file.annotations.map((entry: FailureAnnotation, index) => {
    const usable =
      entry !== null &&
      typeof entry === "object" &&
      (typeof entry.runId === "number" || typeof entry.fingerprint === "string") &&
      (entry.attempt === undefined || typeof entry.attempt === "number") &&
      failureCategories.includes(entry.category) &&
      typeof entry.annotator === "string" &&
      entry.annotator.length > 0;
    if (!usable)
      throw new Error(`annotations[${index}] needs runId or fingerprint, category and annotator`);
    return entry;
  });
}

export function findAnnotation(
  annotations: FailureAnnotation[],
  fingerprint: string,
  attempts: { runId: number; attempt: number }[],
): FailureAnnotation | null {
  return (
    annotations.find((annotation) =>
      annotation.runId !== undefined
        ? attempts.some(
            (attempt) =>
              attempt.runId === annotation.runId &&
              (annotation.attempt === undefined || annotation.attempt === attempt.attempt),
          )
        : annotation.fingerprint === fingerprint,
    ) ?? null
  );
}
