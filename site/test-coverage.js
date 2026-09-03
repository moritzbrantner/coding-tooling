import { parseRepositoryReference } from "./preflight.js";

const coverageCandidates = [
  { path: "coverage/coverage-summary.json", format: "istanbul-summary" },
  { path: "coverage-summary.json", format: "istanbul-summary" },
  { path: "coverage/lcov.info", format: "lcov" },
  { path: "lcov.info", format: "lcov" },
];

export async function testCoverageJson(value, options = {}) {
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    throw new Error("Enter owner/repository or a github.com repository URL.");

  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
  const now = options.now ?? new Date();
  const repository = await githubJson(
    `/repos/${reference.owner}/${reference.name}`,
    fetchImpl,
    signal,
  );
  const tree = await githubJson(
    `/repos/${reference.owner}/${reference.name}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
    fetchImpl,
    signal,
  );
  const blobs = new Map(
    (tree.tree ?? [])
      .filter((entry) => entry.type === "blob" && entry.path && entry.sha)
      .map((entry) => [entry.path, entry]),
  );
  const sources = [];

  for (const candidate of coverageCandidates) {
    const entry = blobs.get(candidate.path);
    if (!entry) continue;

    try {
      const blob = await githubJson(
        `/repos/${reference.owner}/${reference.name}/git/blobs/${entry.sha}`,
        fetchImpl,
        signal,
      );
      if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
      const content = decodeBase64(blob.content);
      const coverage = parseCoverage(content, candidate.format);
      sources.push({ path: candidate.path, format: candidate.format, status: "read" });
      return resultEnvelope(repository, now, {
        status: "available",
        coverage,
        sources,
        source: { path: candidate.path, format: candidate.format },
        treeTruncated: Boolean(tree.truncated),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      sources.push({
        path: candidate.path,
        format: candidate.format,
        status: "unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return resultEnvelope(repository, now, {
    status: tree.truncated || sources.length > 0 ? "incomplete" : "unavailable",
    coverage: null,
    sources,
    source: null,
    treeTruncated: Boolean(tree.truncated),
  });
}

export function parseCoverage(content, format) {
  if (format === "istanbul-summary") return parseIstanbulSummary(content);
  if (format === "lcov") return parseLcov(content);
  throw new Error(`Unsupported coverage format: ${format}`);
}

function parseIstanbulSummary(content) {
  const parsed = JSON.parse(content);
  const total = parsed?.total;
  if (!total || typeof total !== "object") throw new Error("Missing Istanbul total coverage");

  const coverage = {
    lines: metricFromSummary(total.lines),
    statements: metricFromSummary(total.statements),
    functions: metricFromSummary(total.functions),
    branches: metricFromSummary(total.branches),
  };
  if (!Object.values(coverage).some(Boolean)) throw new Error("No coverage totals found");
  return coverage;
}

function parseLcov(content) {
  const counts = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
  };

  for (const line of content.split(/\r?\n/)) {
    addLcovCount(line, "LH:", counts.lines, "covered");
    addLcovCount(line, "LF:", counts.lines, "total");
    addLcovCount(line, "FNH:", counts.functions, "covered");
    addLcovCount(line, "FNF:", counts.functions, "total");
    addLcovCount(line, "BRH:", counts.branches, "covered");
    addLcovCount(line, "BRF:", counts.branches, "total");
  }

  const coverage = {
    lines: metricFromCounts(counts.lines),
    statements: null,
    functions: metricFromCounts(counts.functions),
    branches: metricFromCounts(counts.branches),
  };
  if (!coverage.lines && !coverage.functions && !coverage.branches)
    throw new Error("No LCOV totals found");
  return coverage;
}

function addLcovCount(line, prefix, target, key) {
  if (!line.startsWith(prefix)) return;
  const value = Number(line.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid LCOV ${prefix} value`);
  target[key] += value;
}

function metricFromSummary(value) {
  if (!value || typeof value !== "object") return null;
  const covered = Number(value.covered);
  const total = Number(value.total);
  const percent = Number(value.pct);
  if (!Number.isFinite(covered) || !Number.isFinite(total) || total < 0 || covered < 0) return null;
  return {
    covered,
    total,
    percent: Number.isFinite(percent) ? percent : percentage(covered, total),
  };
}

function metricFromCounts(value) {
  if (value.total === 0) return null;
  return {
    covered: value.covered,
    total: value.total,
    percent: percentage(value.covered, value.total),
  };
}

function percentage(covered, total) {
  if (total === 0) return null;
  return Math.round((covered / total) * 10000) / 100;
}

function resultEnvelope(repository, now, observation) {
  return {
    schemaVersion: 1,
    operation: "test-coverage-observation",
    generatedAt: now.toISOString(),
    repository: {
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      htmlUrl: repository.html_url,
    },
    summary: {
      status: observation.status,
      source: observation.source,
    },
    coverage: observation.coverage,
    sources: observation.sources,
    limitations: [
      "This browser-only observation does not execute repository tests or generate coverage.",
      "Schema version 1 reads recognized coverage reports committed on the repository default branch only.",
      "Missing coverage evidence is reported as unavailable rather than inferred as zero coverage.",
      ...(observation.treeTruncated
        ? ["GitHub truncated the recursive tree, so coverage discovery may be incomplete."]
        : []),
    ],
  };
}

async function githubJson(path, fetchImpl, signal) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.ok) return response.json();
  if (response.status === 404)
    throw new Error(
      "Repository not found. This zero-token Pages observation supports public GitHub repositories only.",
    );
  if (response.status === 403)
    throw new Error(
      "GitHub rejected the anonymous request, usually because the public API rate limit was reached.",
    );
  throw new Error(`GitHub API request failed (${response.status}).`);
}

function decodeBase64(value) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/\n/g, "")), (character) => character.charCodeAt(0)),
  );
}
