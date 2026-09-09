export const DEFAULT_DISCOVERY_OWNER = "moritzbrantner";
export const DISCOVERY_REPOSITORY_LIMIT = 100;
export const DISCOVERY_CANDIDATE_LIMIT = 12;

export async function discoveryJson(owner = DEFAULT_DISCOVERY_OWNER, options = {}) {
  const normalizedOwner = normalizeOwner(owner);
  if (!normalizedOwner) throw new Error("Owner must be a valid GitHub login.");

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const response = await fetchImpl(
    `https://api.github.com/users/${encodeURIComponent(normalizedOwner)}/repos?type=owner&sort=updated&direction=desc&per_page=${DISCOVERY_REPOSITORY_LIMIT}`,
    { headers: { Accept: "application/vnd.github+json" }, signal: options.signal },
  );

  if (!response.ok) throw githubError(response.status);
  const repositories = await response.json();
  if (!Array.isArray(repositories)) throw new Error("GitHub returned an invalid repository list.");

  return analyzeRepositories(normalizedOwner, repositories, now);
}

export function analyzeRepositories(owner, repositories, now = new Date()) {
  const normalizedOwner = normalizeOwner(owner);
  if (!normalizedOwner) throw new Error("Owner must be a valid GitHub login.");

  const candidates = repositories
    .filter((repository) => isEligibleRepository(normalizedOwner, repository))
    .map((repository) => candidate(repository, now))
    .sort(compareCandidates)
    .slice(0, DISCOVERY_CANDIDATE_LIMIT);

  return {
    schemaVersion: 1,
    operation: "repository-discovery",
    generatedAt: now.toISOString(),
    owner: normalizedOwner,
    source: {
      kind: "github-public-api",
      authentication: "none",
      repositoryLimit: DISCOVERY_REPOSITORY_LIMIT,
      truncated: repositories.length >= DISCOVERY_REPOSITORY_LIMIT,
      openItemSemantics: "GitHub open_issues_count includes issues and pull requests.",
    },
    summary: {
      status: candidates.length ? "ready" : "empty",
      suggestedRepository: candidates[0]?.fullName ?? null,
    },
    candidates: candidates.map(({ score: _score, ...entry }) => entry),
  };
}

function isEligibleRepository(owner, repository) {
  if (!repository || repository.private || repository.archived || repository.disabled) return false;
  if (repository.visibility && repository.visibility !== "public") return false;
  return repository.owner?.login?.toLowerCase() === owner.toLowerCase();
}

function candidate(repository, now) {
  const lastActivityAt = latestDate(repository.pushed_at, repository.updated_at, repository.created_at);
  const ageDays = daysSince(lastActivityAt, now);
  const openItemCount = Math.max(0, Number(repository.open_issues_count) || 0);
  const fork = Boolean(repository.fork);

  return {
    score: scoreCandidate({ ageDays, openItemCount, fork }),
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description ?? null,
    htmlUrl: repository.html_url,
    defaultBranch: repository.default_branch,
    language: repository.language ?? null,
    fork,
    openItemCount,
    lastActivityAt: lastActivityAt?.toISOString() ?? null,
    signals: candidateSignals({ ageDays, openItemCount, fork }),
  };
}

function scoreCandidate({ ageDays, openItemCount, fork }) {
  let score = freshnessScore(ageDays);
  score += Math.min(openItemCount, 30) * 2;
  score += fork ? -20 : 10;
  return score;
}

function freshnessScore(ageDays) {
  if (ageDays <= 1) return 100;
  if (ageDays <= 7) return 80;
  if (ageDays <= 30) return 60;
  if (ageDays <= 90) return 40;
  if (ageDays <= 180) return 20;
  return 0;
}

function candidateSignals({ ageDays, openItemCount, fork }) {
  const signals = [];
  if (ageDays <= 7) signals.push("recent-activity");
  else if (ageDays <= 30) signals.push("active-this-month");
  if (openItemCount > 0) signals.push("open-github-items");
  signals.push(fork ? "fork" : "source-repository");
  return signals;
}

function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  const rightActivity = right.lastActivityAt ?? "";
  const leftActivity = left.lastActivityAt ?? "";
  if (rightActivity !== leftActivity) return rightActivity.localeCompare(leftActivity);
  return left.fullName.localeCompare(right.fullName);
}

function latestDate(...values) {
  const dates = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());
  return dates[0] ?? null;
}

function daysSince(date, now) {
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
}

function normalizeOwner(value) {
  const owner = String(value ?? "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
  return owner;
}

function githubError(status) {
  if (status === 404) return new Error("GitHub user not found.");
  if (status === 403)
    return new Error(
      "GitHub anonymous API limit reached. Repository discovery remains token-free; try again after the public rate limit resets.",
    );
  return new Error(`GitHub repository discovery failed with HTTP ${status}.`);
}
