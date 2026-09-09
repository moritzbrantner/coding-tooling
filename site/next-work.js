import { issueChecklistEvidence, issueChecklistNextStep } from "./issue-checklist.js";

export const NEXT_WORK_PULL_LIMIT = 20;
export const NEXT_WORK_ISSUE_LIMIT = 20;
export const NEXT_WORK_CANDIDATE_LIMIT = 12;
export const NEXT_WORK_CI_PULL_LIMIT = 2;
export const NEXT_WORK_CI_EVIDENCE_LIMIT = 100;

export async function nextWorkJson(repository, options = {}) {
  const fullName = normalizeRepository(repository);
  if (!fullName) throw new Error("Repository must be a public GitHub owner/name value.");

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const encodedRepository = fullName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const requestOptions = {
    headers: { Accept: "application/vnd.github+json" },
    signal: options.signal,
  };

  const [pullResponse, issueResponse] = await Promise.all([
    fetchImpl(
      `https://api.github.com/repos/${encodedRepository}/pulls?state=open&sort=updated&direction=desc&per_page=${NEXT_WORK_PULL_LIMIT}`,
      requestOptions,
    ),
    fetchImpl(
      `https://api.github.com/repos/${encodedRepository}/issues?state=open&sort=updated&direction=desc&per_page=${NEXT_WORK_ISSUE_LIMIT}`,
      requestOptions,
    ),
  ]);

  if (!pullResponse.ok) throw githubError(pullResponse.status);
  if (!issueResponse.ok) throw githubError(issueResponse.status);

  const pulls = await pullResponse.json();
  const issueWindow = await issueResponse.json();
  if (!Array.isArray(pulls) || !Array.isArray(issueWindow))
    throw new Error("GitHub returned an invalid open-work list.");

  const result = analyzeOpenWork(fullName, pulls, issueWindow, now);
  return enrichCiHealth(result, encodedRepository, fetchImpl, requestOptions);
}

export function analyzeOpenWork(repository, pulls, issueWindow, now = new Date()) {
  const fullName = normalizeRepository(repository);
  if (!fullName) throw new Error("Repository must be a public GitHub owner/name value.");

  const rankedCandidates = [
    ...pulls.map((pull) => pullCandidate(pull, now)),
    ...issueWindow
      .filter((issue) => !issue.pull_request)
      .map((issue) => issueCandidate(issue, now)),
  ]
    .sort(compareCandidates)
    .slice(0, NEXT_WORK_CANDIDATE_LIMIT);
  const candidates = rankedCandidates.map(({ score: _score, ...candidate }) => candidate);

  return {
    schemaVersion: 1,
    operation: "next-work-discovery",
    generatedAt: now.toISOString(),
    repository: { fullName },
    source: {
      kind: "github-public-api",
      authentication: "none",
      pullLimit: NEXT_WORK_PULL_LIMIT,
      issueWindowLimit: NEXT_WORK_ISSUE_LIMIT,
      pullsTruncated: pulls.length >= NEXT_WORK_PULL_LIMIT,
      issueWindowTruncated: issueWindow.length >= NEXT_WORK_ISSUE_LIMIT,
      issueWindowSemantics:
        "GitHub's issues endpoint includes pull requests; pull-request entries are filtered after the bounded issue window is fetched.",
      issueChecklistSemantics:
        "Markdown task-list items outside fenced code blocks are counted mechanically. Checklist text is exposed as written and is not interpreted semantically.",
    },
    ranking: {
      policy:
        "Rank by recent activity with a modest boost for in-flight pull requests and ready-for-review pull requests.",
      semanticPriority: "not-inferred",
      ciHealth: "not-inspected",
      ciAffectsRanking: false,
      checklistProgress: "observed-not-ranked",
      checklistAffectsRanking: false,
    },
    summary: {
      status: candidates.length ? "ready" : "empty",
      suggestedWork: candidates[0] ?? null,
    },
    candidates,
  };
}

export function summarizeCiEvidence(checkSuitePayload, statusPayload) {
  const checkSuites = Array.isArray(checkSuitePayload?.check_suites)
    ? checkSuitePayload.check_suites
    : null;
  const legacyStatuses = Array.isArray(statusPayload?.statuses) ? statusPayload.statuses : null;
  if (!checkSuites || !legacyStatuses)
    return ciSummary(
      "incomplete",
      checkSuites?.length ?? null,
      legacyStatuses?.length ?? null,
      false,
    );

  const checkSuiteTotal = Number(checkSuitePayload?.total_count);
  const checkSuitesTruncated =
    (Number.isFinite(checkSuiteTotal) && checkSuiteTotal > checkSuites.length) ||
    checkSuites.length >= NEXT_WORK_CI_EVIDENCE_LIMIT;
  const legacyStatusesTruncated = legacyStatuses.length >= NEXT_WORK_CI_EVIDENCE_LIMIT;
  const evidenceTruncated = checkSuitesTruncated || legacyStatusesTruncated;
  const evidenceCount = checkSuites.length + legacyStatuses.length;

  if (evidenceTruncated)
    return ciSummary("incomplete", checkSuites.length, legacyStatuses.length, true);
  if (evidenceCount === 0) return ciSummary("missing", 0, 0, false);
  if (hasFailingEvidence(checkSuites, legacyStatuses))
    return ciSummary("failing", checkSuites.length, legacyStatuses.length, false);
  if (hasPendingEvidence(checkSuites, legacyStatuses))
    return ciSummary("pending", checkSuites.length, legacyStatuses.length, false);
  if (hasUnknownEvidence(checkSuites, legacyStatuses))
    return ciSummary("incomplete", checkSuites.length, legacyStatuses.length, false);
  return ciSummary("passing", checkSuites.length, legacyStatuses.length, false);
}

async function enrichCiHealth(result, encodedRepository, fetchImpl, requestOptions) {
  const inspectedPulls = result.candidates
    .filter((candidate) => candidate.kind === "pull-request" && candidate.headSha)
    .slice(0, NEXT_WORK_CI_PULL_LIMIT);
  const ciEntries = await Promise.all(
    inspectedPulls.map(async (candidate) => [
      candidate.number,
      await loadCiHealth(encodedRepository, candidate.headSha, fetchImpl, requestOptions),
    ]),
  );
  const ciByNumber = new Map(ciEntries);
  const candidates = result.candidates.map((candidate) => {
    const ci = ciByNumber.get(candidate.number);
    return ci ? { ...candidate, ci } : candidate;
  });

  return {
    ...result,
    source: {
      ...result.source,
      ciPullLimit: NEXT_WORK_CI_PULL_LIMIT,
      ciEvidenceLimit: NEXT_WORK_CI_EVIDENCE_LIMIT,
      ciEvidence:
        "For the top pull-request candidates, modern check suites and legacy commit statuses are both inspected. Missing or incomplete evidence is never treated as passing.",
    },
    ranking: {
      ...result.ranking,
      ciHealth: inspectedPulls.length ? "inspected-for-top-pull-requests" : "not-applicable",
    },
    summary: {
      ...result.summary,
      suggestedWork: candidates[0] ?? null,
    },
    candidates,
  };
}

async function loadCiHealth(encodedRepository, headSha, fetchImpl, requestOptions) {
  try {
    const [checkSuiteResponse, statusResponse] = await Promise.all([
      fetchImpl(
        `https://api.github.com/repos/${encodedRepository}/commits/${encodeURIComponent(headSha)}/check-suites?per_page=${NEXT_WORK_CI_EVIDENCE_LIMIT}`,
        requestOptions,
      ),
      fetchImpl(
        `https://api.github.com/repos/${encodedRepository}/commits/${encodeURIComponent(headSha)}/status?per_page=${NEXT_WORK_CI_EVIDENCE_LIMIT}`,
        requestOptions,
      ),
    ]);

    if (!checkSuiteResponse.ok || !statusResponse.ok)
      return {
        status: "unavailable",
        exactHeadSha: headSha,
        requiredness: "not-inspected",
        checkSuiteCount: null,
        legacyStatusCount: null,
        evidenceTruncated: false,
        reason: `github-http-${!checkSuiteResponse.ok ? checkSuiteResponse.status : statusResponse.status}`,
      };

    const [checkSuitePayload, statusPayload] = await Promise.all([
      checkSuiteResponse.json(),
      statusResponse.json(),
    ]);
    return {
      exactHeadSha: headSha,
      requiredness: "not-inspected",
      ...summarizeCiEvidence(checkSuitePayload, statusPayload),
    };
  } catch {
    return {
      status: "unavailable",
      exactHeadSha: headSha,
      requiredness: "not-inspected",
      checkSuiteCount: null,
      legacyStatusCount: null,
      evidenceTruncated: false,
      reason: "request-failed",
    };
  }
}

function pullCandidate(pull, now) {
  const draft = Boolean(pull.draft);
  const updatedAt = validDate(pull.updated_at);
  const ageDays = daysSince(updatedAt, now);
  return {
    score: freshnessScore(ageDays) + (draft ? 40 : 60),
    kind: "pull-request",
    number: pull.number,
    title: String(pull.title ?? "Untitled pull request"),
    htmlUrl: pull.html_url,
    headSha: pull.head?.sha ?? null,
    updatedAt: updatedAt?.toISOString() ?? null,
    author: pull.user?.login ?? null,
    draft,
    action: draft ? "continue-pull-request" : "continue-or-review-pull-request",
    signals: itemSignals({ ageDays, kind: "pull-request", draft, authorType: pull.user?.type }),
  };
}

function issueCandidate(issue, now) {
  const updatedAt = validDate(issue.updated_at);
  const ageDays = daysSince(updatedAt, now);
  const checklist = issueChecklistEvidence(issue.body);
  return {
    score: freshnessScore(ageDays) + 20,
    kind: "issue",
    number: issue.number,
    title: String(issue.title ?? "Untitled issue"),
    htmlUrl: issue.html_url,
    updatedAt: updatedAt?.toISOString() ?? null,
    author: issue.user?.login ?? null,
    draft: false,
    action: "implement-issue",
    checklist,
    nextStep: issueChecklistNextStep(checklist),
    signals: [
      ...itemSignals({ ageDays, kind: "issue", draft: false, authorType: issue.user?.type }),
      ...checklistSignals(checklist),
    ],
  };
}

function ciSummary(status, checkSuiteCount, legacyStatusCount, evidenceTruncated) {
  return {
    status,
    checkSuiteCount,
    legacyStatusCount,
    evidenceTruncated,
  };
}

function hasFailingEvidence(checkSuites, legacyStatuses) {
  const failingConclusions = new Set([
    "action_required",
    "cancelled",
    "failure",
    "stale",
    "startup_failure",
    "timed_out",
  ]);
  return (
    checkSuites.some((suite) => failingConclusions.has(suite.conclusion)) ||
    legacyStatuses.some((status) => status.state === "failure" || status.state === "error")
  );
}

function hasPendingEvidence(checkSuites, legacyStatuses) {
  return (
    checkSuites.some((suite) => suite.status !== "completed" || suite.conclusion == null) ||
    legacyStatuses.some((status) => status.state === "pending")
  );
}

function hasUnknownEvidence(checkSuites, legacyStatuses) {
  const passingConclusions = new Set(["neutral", "skipped", "success"]);
  return (
    checkSuites.some((suite) => !passingConclusions.has(suite.conclusion)) ||
    legacyStatuses.some((status) => status.state !== "success")
  );
}

function itemSignals({ ageDays, kind, draft, authorType }) {
  const signals = [kind === "pull-request" ? "open-pull-request" : "open-issue"];
  if (kind === "pull-request") signals.push(draft ? "draft" : "ready-for-review");
  if (ageDays <= 7) signals.push("recent-activity");
  else if (ageDays <= 30) signals.push("active-this-month");
  if (authorType === "Bot") signals.push("bot-authored");
  return signals;
}

function checklistSignals(checklist) {
  if (checklist.status !== "present") return [];
  if (checklist.remaining > 0) return ["issue-checklist", "open-checklist-items"];
  return ["issue-checklist", "completed-checklist-open-issue"];
}

function freshnessScore(ageDays) {
  if (ageDays <= 1) return 100;
  if (ageDays <= 7) return 80;
  if (ageDays <= 30) return 60;
  if (ageDays <= 90) return 40;
  if (ageDays <= 180) return 20;
  return 0;
}

function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  const rightUpdated = right.updatedAt ?? "";
  const leftUpdated = left.updatedAt ?? "";
  if (rightUpdated !== leftUpdated) return rightUpdated.localeCompare(leftUpdated);
  if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
  return Number(right.number ?? 0) - Number(left.number ?? 0);
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function daysSince(date, now) {
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
}

function normalizeRepository(value) {
  const input = String(value ?? "").trim();
  const match = input.match(
    /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/?$/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function githubError(status) {
  if (status === 404) return new Error("Public GitHub repository not found.");
  if (status === 403)
    return new Error(
      "GitHub anonymous API limit reached. Next-work discovery remains token-free; try again after the public rate limit resets.",
    );
  return new Error(`GitHub next-work discovery failed with HTTP ${status}.`);
}
