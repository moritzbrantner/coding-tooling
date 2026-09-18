import { remoteChangeCommand } from "./change-aware.js";
import { analysisJson } from "./github-analysis.js";

const views = new Set(["full", "agent"]);
const focusKinds = new Set([
  "architecture",
  "automation",
  "browser",
  "dependencies",
  "environment",
  "governance",
  "mobile",
  "performance",
  "testing",
]);
const severities = new Set(["low", "medium", "high"]);
const severityRank = { low: 1, medium: 2, high: 3 };
const allowedParameters = new Set([
  "repo",
  "postMessage",
  "view",
  "focus",
  "scope",
  "min-severity",
  "limit",
  "finding",
  "base",
  "head",
  "changed-file",
  "tier",
]);

export function parseAnalysisQuery(parameters) {
  for (const key of parameters.keys()) {
    if (!allowedParameters.has(key))
      throw new Error(`Unsupported analysis query parameter: ${key}`);
  }

  const view = parameters.get("view") ?? "full";
  if (!views.has(view)) throw new Error("view must be full or agent");

  const focus = uniqueValues(parameters.getAll("focus"));
  if (focus.some((value) => !focusKinds.has(value))) {
    throw new Error(`focus must use one or more of: ${[...focusKinds].join(", ")}`);
  }

  const scope = uniqueValues(parameters.getAll("scope"));
  const minSeverity = parameters.get("min-severity") ?? "low";
  if (!severities.has(minSeverity)) throw new Error("min-severity must be low, medium, or high");

  const defaultLimit = view === "agent" ? 12 : 100;
  const limitValue = parameters.get("limit");
  const limit = limitValue == null ? defaultLimit : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }

  const finding = optionalValue(parameters.get("finding"));
  const base = optionalValue(parameters.get("base"));
  const head = optionalValue(parameters.get("head"));
  const changedFiles = uniqueValues(parameters.getAll("changed-file"));
  const tier = optionalValue(parameters.get("tier")) ?? "fast";
  if (!base && changedFiles.length === 0 && head) {
    throw new Error("head requires base or at least one changed-file");
  }
  if (!base && changedFiles.length === 0 && parameters.has("tier")) {
    throw new Error("tier requires base or at least one changed-file");
  }

  return {
    view,
    focus,
    scope,
    minSeverity,
    limit,
    finding,
    change: {
      base,
      head,
      changedFiles,
      tier,
    },
  };
}

export async function analysisQueryJson(value, parameters, options = {}) {
  const query = parseAnalysisQuery(parameters);
  const analysis = await analysisJson(value, options);
  if (queryIsIdentity(query)) return analysis;
  const changeContext = queryNeedsChangeContext(query)
    ? await remoteChangeCommand(value, changeArgv(query), options)
    : null;
  return projectAnalysis(analysis, query, changeContext);
}

export function projectAnalysis(analysis, query, changeContext = null) {
  const scopedComponents = selectComponents(analysis.components ?? [], query.scope);
  const threshold = severityRank[query.minSeverity];
  const matchingFindings = [...(analysis.findings ?? [])]
    .filter((finding) => severityRank[finding.severity] >= threshold)
    .filter((finding) => !query.finding || finding.id === query.finding)
    .filter((finding) => matchesFocus(finding, query.focus))
    .toSorted(
      (left, right) =>
        severityRank[right.severity] - severityRank[left.severity] ||
        left.id.localeCompare(right.id),
    );

  if (query.finding && matchingFindings.length === 0) {
    throw new Error(`Finding is not available in the selected analysis: ${query.finding}`);
  }

  const findings = matchingFindings.slice(0, query.limit);
  const querySummary = {
    sourceStatus: analysis.summary?.status ?? "unknown",
    selectionStatus:
      analysis.summary?.status === "incomplete" ||
      (changeContext !== null && changeContext.status !== "passed")
        ? "incomplete"
        : findings.some((finding) => finding.severity === "high")
          ? "needs-attention"
          : "no-matching-findings",
    selectedFindingCount: findings.length,
    matchingFindingCount: matchingFindings.length,
    selectedComponentCount: scopedComponents.length,
    findingsTruncated: matchingFindings.length > findings.length,
  };

  if (query.view === "full") {
    return {
      ...analysis,
      operation: "remote-preflight-query",
      query: queryView(query),
      querySummary,
      components: scopedComponents,
      findings,
      changeContext,
      drillDown: drillDown(analysis.repository.fullName, query, findings, changeContext),
    };
  }

  return {
    schemaVersion: 1,
    operation: "remote-preflight-query",
    generatedAt: analysis.generatedAt,
    repository: {
      fullName: analysis.repository.fullName,
      defaultBranch: analysis.repository.defaultBranch,
      revision: analysis.repository.revision ?? null,
      htmlUrl: analysis.repository.htmlUrl,
    },
    query: queryView(query),
    summary: querySummary,
    strongestFinding: findings[0] ? compactFinding(findings[0]) : null,
    findings: findings.map(compactFinding),
    components: scopedComponents.map(compactComponent),
    changeContext: compactChangeContext(changeContext),
    limitations: analysis.limitations ?? [],
    agentHandoff: analysis.agentHandoff,
    drillDown: drillDown(analysis.repository.fullName, query, findings, changeContext),
  };
}

export function queryIsIdentity(query) {
  return (
    query.view === "full" &&
    query.focus.length === 0 &&
    query.scope.length === 0 &&
    query.minSeverity === "low" &&
    query.limit === 100 &&
    query.finding === null &&
    !queryNeedsChangeContext(query)
  );
}

export function queryNeedsChangeContext(query) {
  return Boolean(query.change.base || query.change.changedFiles.length > 0);
}

function changeArgv(query) {
  const argv = ["affected"];
  if (query.change.base) argv.push("--base", query.change.base);
  if (query.change.head) argv.push("--head", query.change.head);
  if (query.change.tier) argv.push("--tier", query.change.tier);
  for (const path of query.change.changedFiles) argv.push("--changed-file", path);
  argv.push("--json");
  return argv;
}

function selectComponents(components, scopes) {
  if (scopes.length === 0) return components;
  for (const scope of scopes) {
    if (!components.some((component) => component.name === scope || component.path === scope)) {
      throw new Error(`Unknown analysis scope: ${scope}`);
    }
  }
  return components.filter(
    (component) => scopes.includes(component.name) || scopes.includes(component.path),
  );
}

function matchesFocus(finding, focus) {
  if (focus.length === 0) return true;
  const categories = findingFocus(finding.id);
  return focus.some((value) => categories.includes(value));
}

function findingFocus(id) {
  if (id.startsWith("REMOTE-TEST-") || id.startsWith("REMOTE-COVERAGE-")) return ["testing"];
  if (id.startsWith("REMOTE-PERFORMANCE-") || id.startsWith("REMOTE-BENCH-"))
    return ["performance"];
  if (id.startsWith("REMOTE-MOBILE-")) return ["mobile"];
  if (id.startsWith("REMOTE-DEPLOY-")) return ["browser", "automation"];
  if (id.startsWith("REMOTE-GOVERNANCE-")) return ["governance", "automation"];
  if (id.startsWith("REMOTE-CI-") || id.startsWith("REMOTE-EXECUTION-")) return ["automation"];
  if (id.startsWith("REMOTE-ENV-")) return ["environment", "dependencies"];
  if (id.startsWith("REMOTE-DEPENDENCY-") || id.startsWith("REMOTE-LOCK-")) return ["dependencies"];
  if (
    id.startsWith("REMOTE-FOUNDATION-") ||
    id.startsWith("REMOTE-AGENT-") ||
    id.startsWith("REMOTE-CAPABILITY-") ||
    id.startsWith("REMOTE-SOURCE-")
  )
    return ["architecture"];
  return [];
}

function compactFinding(finding) {
  return {
    id: finding.id,
    severity: finding.severity,
    focus: findingFocus(finding.id),
    title: finding.title,
    recommendation: finding.recommendation,
    ...(finding.command ? { command: finding.command } : {}),
  };
}

function compactComponent(component) {
  return {
    name: component.name,
    path: component.path,
    kind: component.kind,
    technologies: component.technologies,
    capabilities: Object.keys(component.capabilities ?? {}).toSorted(),
  };
}

function compactChangeContext(context) {
  if (!context) return null;
  const data = context.data ?? {};
  const scope = data.scope ?? {};
  const validationPlan = data.validationPlan ?? {};
  return {
    status: context.status,
    diagnostics: context.diagnostics ?? [],
    change: data.change
      ? {
          base: data.change.base,
          head: data.change.head,
          origin: data.change.origin,
          files: data.change.files,
        }
      : null,
    scope: {
      mode: scope.mode ?? null,
      reasons: scope.reasons ?? [],
      affectedComponents: (scope.affectedComponents ?? []).map((component) => ({
        name: component.name,
        path: component.path,
        kind: component.kind,
        changedPaths: component.changedPaths,
        governingContracts: component.governingContracts,
        candidateTests: component.candidateTests,
      })),
    },
    validationPlan: {
      tier: validationPlan.tier ?? null,
      complete: validationPlan.complete ?? false,
      checkCount: validationPlan.checks?.length ?? 0,
      missing: validationPlan.missing ?? [],
    },
  };
}

function queryView(query) {
  return {
    view: query.view,
    focus: query.focus,
    scope: query.scope,
    minSeverity: query.minSeverity,
    limit: query.limit,
    finding: query.finding,
    change: query.change,
  };
}

function drillDown(repository, query, findings, changeContext) {
  const full = analysisUrl(repository, { ...query, view: "full", limit: 100, finding: null });
  const strongest = findings[0]
    ? analysisUrl(repository, { ...query, view: "full", limit: 100, finding: findings[0].id })
    : null;
  const affected = changeContext ? affectedUrl(repository, query) : null;
  return {
    fullAnalysis: full,
    strongestFinding: strongest,
    affectedAnalysis: affected,
  };
}

function analysisUrl(repository, query) {
  const parameters = new URLSearchParams();
  parameters.set("repo", repository);
  parameters.set("view", query.view);
  for (const value of query.focus) parameters.append("focus", value);
  for (const value of query.scope) parameters.append("scope", value);
  if (query.minSeverity !== "low") parameters.set("min-severity", query.minSeverity);
  if (query.limit !== (query.view === "agent" ? 12 : 100)) {
    parameters.set("limit", String(query.limit));
  }
  if (query.finding) parameters.set("finding", query.finding);
  if (query.change.base) parameters.set("base", query.change.base);
  if (query.change.head) parameters.set("head", query.change.head);
  for (const path of query.change.changedFiles) parameters.append("changed-file", path);
  if (query.change.tier !== "fast") parameters.set("tier", query.change.tier);
  return `./analysis.json/?${parameters.toString()}`;
}

function affectedUrl(repository, query) {
  const parameters = new URLSearchParams();
  parameters.set("repo", repository);
  if (query.change.base) parameters.set("base", query.change.base);
  if (query.change.head) parameters.set("head", query.change.head);
  for (const path of query.change.changedFiles) parameters.append("file", path);
  parameters.set("tier", query.change.tier);
  return `./affected.json/?${parameters.toString()}`;
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

function optionalValue(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
