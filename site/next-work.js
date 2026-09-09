export const NEXT_WORK_PULL_LIMIT = 20;
export const NEXT_WORK_ISSUE_LIMIT = 20;
export const NEXT_WORK_CANDIDATE_LIMIT = 12;

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

  return analyzeOpenWork(fullName, pulls, issueWindow, now);
}

export function analyzeOpenWork(repository, pulls, issueWindow, now = new Date()) {
  const fullName = normalizeRepository(repository);
  if (!fullName) throw new Error("Repository must be a public GitHub owner/name value.");

  const candidates = [
    ...pulls.map((pull) => pullCandidate(pull, now)),
    ...issueWindow.filter((issue) => !issue.pull_request).map((issue) => issueCandidate(issue, now)),
  ]
    .sort(compareCandidates)
    .slice(0, NEXT_WORK_CANDIDATE_LIMIT);

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
    },
    ranking: {
      policy:
        "Rank by recent activity with a modest boost for in-flight pull requests and ready-for-review pull requests.",
      semanticPriority: "not-inferred",
      ciHealth: "not-inspected",
    },
    summary: {
      status: candidates.length ? "ready" : "empty",
      suggestedWork: candidates[0] ?? null,
    },
    candidates: candidates.map(({ score: _score, ...candidate }) => candidate),
  };
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
    signals: itemSignals({ ageDays, kind: "issue", draft: false, authorType: issue.user?.type }),
  };
}

function itemSignals({ ageDays, kind, draft, authorType }) {
  const signals = [kind === "pull-request" ? "open-pull-request" : "open-issue"];
  if (kind === "pull-request") signals.push(draft ? "draft" : "ready-for-review");
  if (ageDays <= 7) signals.push("recent-activity");
  else if (ageDays <= 30) signals.push("active-this-month");
  if (authorType === "Bot") signals.push("bot-authored");
  return signals;
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
