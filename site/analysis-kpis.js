import { issueChecklistEvidence } from "./issue-checklist.js";
import { parsePublishedSnapshot } from "./test-coverage.js";

export const ANALYSIS_KPI_ISSUE_LIMIT = 20;
export const ANALYSIS_KPI_OBSERVATION_BRANCH = "coding-tooling-observations";
export const ANALYSIS_KPI_COVERAGE_PATH = ".coding-tooling/test-coverage.json";
export const ANALYSIS_KPI_PUBLIC_CONTRACT_PATH = ".coding-tooling/public-contract.json";
export const ANALYSIS_KPI_SCORE_HISTORY_BRANCH = "score-history";
export const ANALYSIS_KPI_SCORE_HISTORY_PATH = "history.json";

const strongContractEvidenceKinds = new Set([
  "behavioral",
  "contract",
  "render",
  "interaction",
  "accessibility",
  "visual",
  "package",
  "compile",
]);

export async function analysisKpisJson(reference, analysis, snapshot, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
  const currentRevision = snapshot.repository.revision ?? null;

  const [work, testCoverage, verification, publicContracts] = await Promise.all([
    loadWorkKpis(reference, snapshot.repository, fetchImpl, signal),
    loadCoverageKpis(reference, snapshot.repository, currentRevision, fetchImpl, signal),
    loadVerificationKpis(reference, snapshot.repository, currentRevision, fetchImpl, signal),
    loadPublicContractKpis(reference, snapshot.repository, currentRevision, fetchImpl, signal),
  ]);

  return {
    schemaVersion: 1,
    work,
    testCoverage,
    publicContracts,
    verification,
    findings: {
      status: "observed",
      total: analysis.summary.findingCount,
      highPriority: analysis.summary.highPriorityFindingCount,
      source: "remote-preflight",
    },
  };
}

async function loadWorkKpis(reference, repository, fetchImpl, signal) {
  const request = await githubOptionalJson(
    `/repos/${reference.owner}/${reference.name}/issues?state=open&sort=updated&direction=desc&per_page=${ANALYSIS_KPI_ISSUE_LIMIT}`,
    fetchImpl,
    signal,
  );
  const openGithubItems = {
    status: Number.isInteger(repository.openIssues) ? "observed" : "unavailable",
    value: Number.isInteger(repository.openIssues) ? repository.openIssues : null,
    semantics: "GitHub repository open_issues_count combines open issues and pull requests.",
  };

  if (request.status !== "observed" || !Array.isArray(request.value)) {
    return {
      status: "unavailable",
      openGithubItems,
      checklist: unavailableChecklist(request.reason ?? "open-issue-window-unavailable"),
    };
  }

  const issueWindow = request.value.filter((item) => !item?.pull_request);
  const checklists = issueWindow
    .map((issue) => ({
      issueNumber: issue.number,
      title: issue.title ?? null,
      checklist: issueChecklistEvidence(issue.body),
    }))
    .filter((item) => item.checklist.status === "present");
  const totals = checklists.reduce(
    (result, item) => {
      result.total += item.checklist.total;
      result.completed += item.checklist.completed;
      result.remaining += item.checklist.remaining;
      return result;
    },
    { total: 0, completed: 0, remaining: 0 },
  );
  const firstRemaining = checklists.find((item) => item.checklist.firstUnchecked)?.checklist
    .firstUnchecked;
  const firstRemainingIssue = checklists.find((item) => item.checklist.firstUnchecked);
  const truncated = request.value.length >= ANALYSIS_KPI_ISSUE_LIMIT;

  return {
    status: truncated ? "incomplete" : "observed",
    openGithubItems,
    checklist: {
      status: truncated ? "incomplete" : "observed",
      issueWindowLimit: ANALYSIS_KPI_ISSUE_LIMIT,
      issuesInspected: issueWindow.length,
      issuesWithChecklists: checklists.length,
      total: totals.total,
      completed: totals.completed,
      remaining: totals.remaining,
      completionPercent: percentage(totals.completed, totals.total),
      semantics:
        "Mechanical task-box counts across inspected issues; overlapping issue scopes are not de-duplicated.",
      firstRemaining:
        firstRemaining && firstRemainingIssue
          ? {
              issueNumber: firstRemainingIssue.issueNumber,
              text: firstRemaining.text,
            }
          : null,
      reason: truncated
        ? "The bounded GitHub issue window is full, so aggregate checklist counts may omit older open issues."
        : null,
    },
  };
}

async function loadCoverageKpis(reference, repository, currentRevision, fetchImpl, signal) {
  const request = await githubOptionalJson(
    `/repos/${reference.owner}/${reference.name}/contents/${ANALYSIS_KPI_COVERAGE_PATH}?ref=${encodeURIComponent(ANALYSIS_KPI_OBSERVATION_BRANCH)}`,
    fetchImpl,
    signal,
  );
  if (request.status !== "observed") return unavailableCoverage(request.reason);

  try {
    const resource = request.value;
    if (resource?.type !== "file" || resource?.encoding !== "base64")
      throw new Error("published-coverage-not-readable");
    const snapshot = parsePublishedSnapshot(decodeBase64(resource.content), repository.fullName);
    const freshness = evidenceFreshness(snapshot.repository.revision, currentRevision);
    return {
      status: freshness === "current" ? "observed" : "incomplete",
      freshness,
      revision: snapshot.repository.revision,
      generatedAt: snapshot.generatedAt,
      lines: coverageMetric(snapshot.coverage.lines),
      statements: coverageMetric(snapshot.coverage.statements),
      functions: coverageMetric(snapshot.coverage.functions),
      branches: coverageMetric(snapshot.coverage.branches),
      source: {
        branch: ANALYSIS_KPI_OBSERVATION_BRANCH,
        path: ANALYSIS_KPI_COVERAGE_PATH,
      },
    };
  } catch (error) {
    return {
      ...unavailableCoverage(errorMessage(error)),
      status: "incomplete",
    };
  }
}

async function loadVerificationKpis(reference, repository, currentRevision, fetchImpl, signal) {
  const request = await githubOptionalJson(
    `/repos/${reference.owner}/${reference.name}/contents/${ANALYSIS_KPI_SCORE_HISTORY_PATH}?ref=${encodeURIComponent(ANALYSIS_KPI_SCORE_HISTORY_BRANCH)}`,
    fetchImpl,
    signal,
  );
  if (request.status !== "observed") return unavailableVerification(request.reason);

  try {
    const resource = request.value;
    if (resource?.type !== "file" || resource?.encoding !== "base64")
      throw new Error("score-history-not-readable");
    const history = JSON.parse(decodeBase64(resource.content));
    if (history?.schemaVersion !== "coding-tooling/score-history/v1")
      throw new Error("unsupported-score-history-schema");
    if (history.repository !== repository.fullName) throw new Error("score-history-repository-mismatch");
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const exact = currentRevision ? entries.find((entry) => entry?.commit === currentRevision) : null;
    const latest = exact ?? entries.at(-1) ?? null;
    if (!latest) return unavailableVerification("score-history-empty");
    const freshness = evidenceFreshness(latest.commit, currentRevision);
    const verification = latest.verification;
    if (!verification || typeof verification !== "object")
      return {
        ...unavailableVerification("verification-summary-unavailable"),
        status: freshness === "current" ? "incomplete" : "unavailable",
        freshness,
        revision: latest.commit ?? null,
      };

    const producerStatus =
      typeof verification.status === "string" ? verification.status : "unavailable";
    const status =
      producerStatus === "error"
        ? "incomplete"
        : freshness === "current"
          ? "observed"
          : "incomplete";

    return {
      status,
      freshness,
      revision: latest.commit ?? null,
      producerStatus,
      repositoryScore: finiteOrNull(latest.score),
      verificationScore: finiteOrNull(verification.score),
      checks: {
        planned: integerOrNull(verification.plannedChecks),
        passed: integerOrNull(verification.passedChecks),
        failed: integerOrNull(verification.failedChecks),
        error: integerOrNull(verification.errorChecks),
        blocked: integerOrNull(verification.blockedChecks),
        missingRequiredCapabilities: integerOrNull(verification.missingRequiredCapabilities),
      },
      reason: producerStatus === "error" ? "score-production-error-tombstone" : null,
      source: {
        branch: ANALYSIS_KPI_SCORE_HISTORY_BRANCH,
        path: ANALYSIS_KPI_SCORE_HISTORY_PATH,
      },
    };
  } catch (error) {
    return {
      ...unavailableVerification(errorMessage(error)),
      status: "incomplete",
    };
  }
}

async function loadPublicContractKpis(reference, repository, currentRevision, fetchImpl, signal) {
  const request = await githubOptionalJson(
    `/repos/${reference.owner}/${reference.name}/contents/${ANALYSIS_KPI_PUBLIC_CONTRACT_PATH}?ref=${encodeURIComponent(ANALYSIS_KPI_OBSERVATION_BRANCH)}`,
    fetchImpl,
    signal,
  );
  if (request.status !== "observed") return unavailablePublicContracts(request.reason);

  try {
    const resource = request.value;
    if (resource?.type !== "file" || resource?.encoding !== "base64")
      throw new Error("published-public-contract-not-readable");
    const snapshot = parsePublicContractSnapshot(decodeBase64(resource.content), repository.fullName);
    const freshness = evidenceFreshness(snapshot.repository.revision, currentRevision);
    const report = snapshot.report;
    const surfaces = Array.isArray(report.surfaces) ? report.surfaces : [];
    const endpoints = surfaces.filter((surface) => surface?.kind === "http-operation");
    const verifiedEndpoints = endpoints.filter((surface) => surfaceIsVerified(surface)).length;

    return {
      status: freshness === "current" ? "observed" : "incomplete",
      freshness,
      revision: snapshot.repository.revision,
      generatedAt: snapshot.generatedAt,
      contracts: {
        discovered: integerOrNull(report.summary?.discovered),
        verified: integerOrNull(report.summary?.verified),
        unverified: integerOrNull(report.summary?.unverified),
        incompleteDiscovery: integerOrNull(report.summary?.incompleteDiscovery),
        verifiedRatio: finiteOrNull(report.summary?.verifiedRatio),
      },
      httpEndpoints: {
        discovered: endpoints.length,
        verified: verifiedEndpoints,
        unverified: endpoints.length - verifiedEndpoints,
        verifiedRatio: endpoints.length ? verifiedEndpoints / endpoints.length : null,
      },
      source: {
        branch: ANALYSIS_KPI_OBSERVATION_BRANCH,
        path: ANALYSIS_KPI_PUBLIC_CONTRACT_PATH,
      },
    };
  } catch (error) {
    return {
      ...unavailablePublicContracts(errorMessage(error)),
      status: "incomplete",
    };
  }
}

export function parsePublicContractSnapshot(content, expectedRepository) {
  const parsed = JSON.parse(content);
  if (parsed?.schemaVersion !== 1 || parsed?.kind !== "coding-tooling-public-contract-snapshot")
    throw new Error("unsupported-public-contract-snapshot-schema");
  if (parsed?.repository?.fullName !== expectedRepository)
    throw new Error("public-contract-snapshot-repository-mismatch");
  if (!/^[0-9a-f]{40}$/i.test(parsed?.repository?.revision ?? ""))
    throw new Error("public-contract-snapshot-revision-invalid");
  if (!parsed.generatedAt || Number.isNaN(Date.parse(parsed.generatedAt)))
    throw new Error("public-contract-snapshot-generated-at-invalid");
  if (parsed?.report?.schemaVersion !== 1 || !parsed?.report?.summary)
    throw new Error("public-contract-report-invalid");
  if (parsed.report.revision && parsed.report.revision !== parsed.repository.revision)
    throw new Error("public-contract-snapshot-report-revision-mismatch");
  return parsed;
}

function surfaceIsVerified(surface) {
  if (surface?.status === "verified") return true;
  const evidence = Array.isArray(surface?.evidence) ? surface.evidence : [];
  return evidence.some(
    (item) => item?.outcome === "passed" && strongContractEvidenceKinds.has(item?.kind),
  );
}

function coverageMetric(metric) {
  if (!metric) return null;
  return {
    covered: metric.covered,
    total: metric.total,
    uncovered: metric.total - metric.covered,
    percent: metric.percent,
  };
}

function unavailableChecklist(reason) {
  return {
    status: "unavailable",
    issueWindowLimit: ANALYSIS_KPI_ISSUE_LIMIT,
    issuesInspected: null,
    issuesWithChecklists: null,
    total: null,
    completed: null,
    remaining: null,
    completionPercent: null,
    firstRemaining: null,
    reason: reason ?? "unavailable",
  };
}

function unavailableCoverage(reason) {
  return {
    status: "unavailable",
    freshness: "unknown",
    revision: null,
    generatedAt: null,
    lines: null,
    statements: null,
    functions: null,
    branches: null,
    reason: reason ?? "published-test-coverage-unavailable",
    source: {
      branch: ANALYSIS_KPI_OBSERVATION_BRANCH,
      path: ANALYSIS_KPI_COVERAGE_PATH,
    },
  };
}

function unavailableVerification(reason) {
  return {
    status: "unavailable",
    freshness: "unknown",
    revision: null,
    producerStatus: null,
    repositoryScore: null,
    verificationScore: null,
    checks: {
      planned: null,
      passed: null,
      failed: null,
      error: null,
      blocked: null,
      missingRequiredCapabilities: null,
    },
    reason: reason ?? "score-history-unavailable",
    source: {
      branch: ANALYSIS_KPI_SCORE_HISTORY_BRANCH,
      path: ANALYSIS_KPI_SCORE_HISTORY_PATH,
    },
  };
}

function unavailablePublicContracts(reason) {
  return {
    status: "unavailable",
    freshness: "unknown",
    revision: null,
    generatedAt: null,
    contracts: {
      discovered: null,
      verified: null,
      unverified: null,
      incompleteDiscovery: null,
      verifiedRatio: null,
    },
    httpEndpoints: {
      discovered: null,
      verified: null,
      unverified: null,
      verifiedRatio: null,
    },
    reason: reason ?? "published-public-contract-unavailable",
    source: {
      branch: ANALYSIS_KPI_OBSERVATION_BRANCH,
      path: ANALYSIS_KPI_PUBLIC_CONTRACT_PATH,
    },
  };
}

async function githubOptionalJson(path, fetchImpl, signal) {
  try {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.ok) return { status: "observed", value: await response.json() };
    if (response.status === 404)
      return { status: "unavailable", value: null, reason: "github-http-404" };
    return { status: "unavailable", value: null, reason: `github-http-${response.status}` };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { status: "unavailable", value: null, reason: "request-failed" };
  }
}

function evidenceFreshness(revision, currentRevision) {
  if (!currentRevision) return "unknown";
  return revision === currentRevision ? "current" : "stale";
}

function percentage(completed, total) {
  if (!total) return null;
  return Math.round((completed / total) * 10000) / 100;
}

function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(value) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(String(value ?? "").replace(/\n/g, "")), (character) =>
      character.charCodeAt(0),
    ),
  );
}
