import { analysisKpisJson } from "./analysis-kpis.js";
import { resolveRequestedRevision } from "./github-revision.js";
import { applyExecutionEvidence } from "./execution-evidence.js";
import { applyHostedMergePolicy } from "./hosted-merge-policy.js";
import {
  declaredMergeAuthorityEvidence,
  mergeAuthorityConsistency,
} from "./merge-authority-evidence.js";
import {
  DEFAULT_REMOTE_FETCH_CONCURRENCY,
  mapWithConcurrency,
  selectRemoteFilesByByteBudget,
  selectRustSourceFilesByByteBudget,
} from "./remote-acquisition.js";
import { discoverReusableWorkflowCalls } from "./reusable-workflow.js";
import { analyzeSnapshot, parseRepositoryReference, selectedWorkflowFiles } from "./preflight.js";

const DEFAULT_REUSABLE_WORKFLOW_LIMIT = 8;
const DEFAULT_REUSABLE_WORKFLOW_BYTE_BUDGET = 256 * 1024;

export async function analysisJson(value, options = {}) {
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    throw new Error("Enter owner/repository or a github.com repository URL.");

  const snapshot = await loadSnapshot(reference, options);
  const structuralAnalysis = analyzeSnapshot(snapshot, options.now ?? new Date());
  const executionAnalysis = applyExecutionEvidence(structuralAnalysis, snapshot);
  const declaredMergeAuthority = declaredMergeAuthorityFromSnapshot(snapshot);
  const mergeAuthority = mergeAuthorityConsistency(
    declaredMergeAuthority,
    snapshot.repository.governance.defaultBranchProtection,
  );
  const analysis = applyHostedMergePolicy(
    executionAnalysis,
    declaredMergeAuthority,
    mergeAuthority,
  );
  const kpis = await analysisKpisJson(reference, analysis, snapshot, options);
  return {
    ...analysis,
    declaredMergeAuthority,
    mergeAuthorityConsistency: mergeAuthority,
    kpis,
  };
}

export async function loadSnapshot(reference, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
  const repository = await githubJson(
    `/repos/${reference.owner}/${reference.name}`,
    fetchImpl,
    signal,
  );
  const inspectDefaultBranch = shouldInspectDefaultBranch(repository);
  const defaultBranch = inspectDefaultBranch
    ? await githubOptionalJson(
        `/repos/${reference.owner}/${reference.name}/branches/${encodeURIComponent(repository.default_branch)}`,
        fetchImpl,
        signal,
      )
    : {
        status: "unavailable",
        reason: "repository-governance-metadata-unavailable",
      };
  const requestedRef = normalizeRequestedRef(options.ref);
  const defaultRevision = defaultBranchRevision(defaultBranch);
  const resolvedRevision = requestedRef
    ? await resolveRequestedRevision(reference, requestedRef, (path) =>
        githubJson(path, fetchImpl, signal),
      )
    : defaultRevision;
  const treeRef = resolvedRevision ?? repository.default_branch;
  const tree = await githubJson(
    `/repos/${reference.owner}/${reference.name}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`,
    fetchImpl,
    signal,
  );
  const entries = (tree.tree ?? []).filter(
    (entry) => entry.path && entry.sha && ["blob", "tree"].includes(entry.type),
  );
  const manifestAcquisition = selectRemoteFilesByByteBudget(entries, options.manifestByteBudget);
  const rustSourceAcquisition = selectRustSourceFilesByByteBudget(
    entries,
    options.rustSourceByteBudget,
  );
  const selectedBase = manifestAcquisition.selected;
  const selectedRustSources = rustSourceAcquisition.selected;
  const selectedWorkflows = selectedWorkflowFiles(entries);
  const rootAction = entries.find(
    (entry) => entry.type === "blob" && ["action.yml", "action.yaml"].includes(entry.path),
  );
  const selected = [
    ...selectedBase,
    ...selectedRustSources,
    ...selectedWorkflows,
    ...(rootAction && !selectedBase.some((entry) => entry.path === rootAction.path)
      ? [rootAction]
      : []),
  ];
  const eligibleWorkflows = selectedWorkflowFiles(entries, entries.length);
  const workflowFetchTruncated = selectedWorkflows.length < eligibleWorkflows.length;
  const files = {};
  const unreadablePaths = [];
  const unreadableRustSourcePaths = [];
  const rustSourcePaths = new Set(selectedRustSources.map((entry) => entry.path));

  await mapWithConcurrency(
    deduplicateEntries(selected),
    options.fetchConcurrency ?? DEFAULT_REMOTE_FETCH_CONCURRENCY,
    async (entry) => {
      try {
        const blob = await githubJson(
          `/repos/${reference.owner}/${reference.name}/git/blobs/${entry.sha}`,
          fetchImpl,
          signal,
        );
        if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
        files[entry.path] = decodeBase64(blob.content);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (rustSourcePaths.has(entry.path)) unreadableRustSourcePaths.push(entry.path);
        else unreadablePaths.push(entry.path);
      }
    },
  );

  const loadedWorkflows = selectedWorkflows
    .filter((entry) => typeof files[entry.path] === "string")
    .map((entry) => ({ path: entry.path, content: files[entry.path] }));
  const reusableWorkflowCalls = discoverReusableWorkflowCalls(loadedWorkflows);
  const reusableWorkflowAcquisition = await loadReusableWorkflowEvidence({
    calls: reusableWorkflowCalls,
    repository: repository.full_name,
    revision: resolvedRevision,
    files,
    fetchImpl,
    signal,
    callLimit: options.reusableWorkflowLimit,
    byteBudget: options.reusableWorkflowByteBudget,
  });

  return {
    repository: {
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      revision: resolvedRevision,
      requestedRef,
      htmlUrl: repository.html_url,
      description: repository.description,
      archived: repository.archived,
      fork: repository.fork,
      stars: repository.stargazers_count,
      openIssues: repository.open_issues_count,
      governance: repositoryGovernanceEvidence(repository, defaultBranch),
    },
    tree: entries,
    files,
    treeTruncated: Boolean(tree.truncated),
    revisionUnavailable: requestedRef ? false : inspectDefaultBranch && !resolvedRevision,
    manifestFetchTruncated: !manifestAcquisition.complete,
    manifestAcquisition: {
      byteBudget: manifestAcquisition.byteBudget,
      selectedBytes: manifestAcquisition.selectedBytes,
      reason: manifestAcquisition.reason,
      blockedPath: manifestAcquisition.blockedPath,
      eligibleCount: manifestAcquisition.eligible.length,
      selectedCount: manifestAcquisition.selected.length,
    },
    rustSourceFetchTruncated: !rustSourceAcquisition.complete,
    rustSourceAcquisition: {
      byteBudget: rustSourceAcquisition.byteBudget,
      selectedBytes: rustSourceAcquisition.selectedBytes,
      reason: rustSourceAcquisition.reason,
      blockedPath: rustSourceAcquisition.blockedPath,
      eligibleCount: rustSourceAcquisition.eligible.length,
      selectedCount: rustSourceAcquisition.selected.length,
    },
    workflowFetchTruncated,
    unreadablePaths: unreadablePaths.toSorted(),
    unreadableRustSourcePaths: unreadableRustSourcePaths.toSorted(),
    reusableWorkflows: reusableWorkflowAcquisition.evidence,
    reusableWorkflowAcquisition: reusableWorkflowAcquisition.summary,
  };
}

async function loadReusableWorkflowEvidence(input) {
  const callLimit = boundedOption(
    input.callLimit,
    DEFAULT_REUSABLE_WORKFLOW_LIMIT,
    "reusable workflow call limit",
  );
  const byteBudget = boundedOption(
    input.byteBudget,
    DEFAULT_REUSABLE_WORKFLOW_BYTE_BUDGET,
    "reusable workflow byte budget",
  );
  const selectedCalls = input.calls.slice(0, callLimit);
  const cache = new Map();
  const evidence = [];
  let selectedBytes = 0;
  let blockedReference = null;

  for (const call of selectedCalls) {
    if (call.target.status === "unsupported") {
      evidence.push({ ...call, status: "unsupported", reason: call.target.reason });
      continue;
    }
    const repository = call.target.repository ?? input.repository;
    const ref = call.target.ref ?? input.revision;
    if (!ref) {
      evidence.push({ ...call, status: "incomplete", reason: "exact-revision-unavailable" });
      continue;
    }

    const key = `${repository}@${ref}:${call.target.path}`;
    let resolved = cache.get(key);
    if (!resolved) {
      const localContent =
        repository === input.repository && ref === input.revision
          ? input.files[call.target.path]
          : null;
      resolved =
        typeof localContent === "string"
          ? { status: "resolved", content: localContent }
          : await githubOptionalTextFile(
              repository,
              call.target.path,
              ref,
              input.fetchImpl,
              input.signal,
            );
      if (resolved.status === "resolved") {
        const bytes = new TextEncoder().encode(resolved.content).length;
        if (selectedBytes + bytes > byteBudget) {
          blockedReference = key;
          resolved = { status: "incomplete", reason: "byte-budget-exceeded" };
        } else {
          selectedBytes += bytes;
          resolved = { ...resolved, bytes };
        }
      }
      cache.set(key, resolved);
    }

    evidence.push({
      ...call,
      status: resolved.status,
      ...(resolved.reason ? { reason: resolved.reason } : {}),
      repository,
      ref,
      path: call.target.path,
      ...(resolved.status === "resolved" ? { content: resolved.content } : {}),
    });
  }

  const limited = selectedCalls.length < input.calls.length;
  const incomplete = evidence.some((item) => item.status !== "resolved");
  return {
    evidence,
    summary: {
      callLimit,
      byteBudget,
      discoveredCount: input.calls.length,
      selectedCount: selectedCalls.length,
      resolvedCount: evidence.filter((item) => item.status === "resolved").length,
      selectedBytes,
      complete: !limited && !incomplete,
      reason: limited
        ? "call-limit-exceeded"
        : blockedReference
          ? "byte-budget-exceeded"
          : incomplete
            ? "resolution-incomplete"
            : "within-bounds",
      blockedReference,
    },
  };
}

async function githubOptionalTextFile(repository, path, ref, fetchImpl, signal) {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      {
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) return { status: "incomplete", reason: `github-http-${response.status}` };
    const file = await response.json();
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
      return { status: "incomplete", reason: "reusable-workflow-content-unavailable" };
    }
    return { status: "resolved", content: decodeBase64(file.content) };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { status: "incomplete", reason: "request-failed" };
  }
}

function boundedOption(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return selected;
}

function deduplicateEntries(entries) {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

export function repositoryGovernanceEvidence(repository, defaultBranch = {}) {
  return {
    schemaVersion: 1,
    provenance: {
      provider: "github",
      source: "repository-metadata",
      authentication: "none",
    },
    license: licenseEvidence(repository),
    mergeStrategies: {
      mergeCommit: booleanMetadataEvidence(repository, "allow_merge_commit"),
      squash: booleanMetadataEvidence(repository, "allow_squash_merge"),
      rebase: booleanMetadataEvidence(repository, "allow_rebase_merge"),
      autoMerge: booleanMetadataEvidence(repository, "allow_auto_merge"),
    },
    pages: booleanMetadataEvidence(repository, "has_pages"),
    defaultBranchProtection: defaultBranchProtectionEvidence(defaultBranch),
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
      "Repository not found. This zero-token Pages preflight supports public GitHub repositories only.",
    );
  if (response.status === 403)
    throw new Error(
      "GitHub rejected the anonymous request, usually because the public API rate limit was reached. Run coding-tooling locally for an unthrottled analysis.",
    );
  throw new Error(`GitHub API request failed (${response.status}).`);
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
    if (!response.ok) return { status: "unavailable", reason: `github-http-${response.status}` };
    return { status: "observed", value: await response.json() };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { status: "unavailable", reason: "request-failed" };
  }
}

function declaredMergeAuthorityFromSnapshot(snapshot) {
  const raw = snapshot.files[".coding-tooling.json"];
  if (!raw) return declaredMergeAuthorityEvidence(null);
  try {
    return declaredMergeAuthorityEvidence(JSON.parse(raw));
  } catch {
    return {
      state: "invalid",
      authority: null,
      requiredChecks: [],
      reason: "coding-tooling-config-invalid-json",
      source: ".coding-tooling.json",
      observedEnforcement: "not-evaluated",
    };
  }
}

function normalizeRequestedRef(value) {
  const ref = String(value ?? "").trim();
  return ref || null;
}

function defaultBranchRevision(observation) {
  if (observation?.status !== "observed") return null;
  const revision = observation.value?.commit?.sha;
  return /^[0-9a-f]{40}$/i.test(revision ?? "") ? revision : null;
}

function defaultBranchProtectionEvidence(observation) {
  if (observation?.status !== "observed")
    return unavailableBranchProtectionEvidence(
      observation?.reason ?? "branch-metadata-not-inspected",
    );

  const branch = observation.value;
  if (typeof branch?.protected !== "boolean")
    return unavailableBranchProtectionEvidence("invalid-branch-metadata-shape");

  return {
    status: "observed",
    protected: branch.protected,
    provenance: { source: "default-branch-metadata" },
    requiredStatusChecks: requiredStatusChecksEvidence(branch),
  };
}

function requiredStatusChecksEvidence(branch) {
  const required = branch.protection?.required_status_checks;
  if (!required) {
    if (!branch.protected) return { status: "observed", names: [] };
    return {
      status: "unavailable",
      names: null,
      reason: "required-status-checks-not-exposed",
    };
  }

  const contexts = Array.isArray(required.contexts)
    ? required.contexts.filter((context) => typeof context === "string")
    : [];
  const checks = Array.isArray(required.checks)
    ? required.checks
        .map((check) => check?.context)
        .filter((context) => typeof context === "string")
    : [];
  return { status: "observed", names: [...new Set([...contexts, ...checks])].toSorted() };
}

function unavailableBranchProtectionEvidence(reason) {
  return {
    status: "unavailable",
    protected: null,
    reason,
    requiredStatusChecks: { status: "unavailable", names: null, reason },
  };
}

function shouldInspectDefaultBranch(repository) {
  return [
    "license",
    "allow_merge_commit",
    "allow_squash_merge",
    "allow_rebase_merge",
    "allow_auto_merge",
    "has_pages",
  ].some((field) => Object.hasOwn(repository, field));
}

function licenseEvidence(repository) {
  if (!Object.hasOwn(repository, "license")) return unavailableMetadataEvidence();
  const license = repository.license;
  return {
    status: "observed",
    present: license != null,
    spdxId: license?.spdx_id ?? null,
    name: license?.name ?? null,
  };
}

function booleanMetadataEvidence(repository, field) {
  if (!Object.hasOwn(repository, field)) return unavailableMetadataEvidence();
  const value = repository[field];
  if (typeof value !== "boolean") return unavailableMetadataEvidence("invalid-metadata-shape");
  return { status: "observed", value };
}

function unavailableMetadataEvidence(reason = "field-not-exposed") {
  return { status: "unavailable", value: null, reason };
}

function decodeBase64(value) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/\n/g, "")), (character) => character.charCodeAt(0)),
  );
}
