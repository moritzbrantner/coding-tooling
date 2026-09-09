import {
  declaredMergeAuthorityEvidence,
  mergeAuthorityConsistency,
} from "./merge-authority-evidence.js";
import {
  analyzeSnapshot,
  parseRepositoryReference,
  selectedRemoteFiles,
  selectedWorkflowFiles,
} from "./preflight.js";

export async function analysisJson(value, options = {}) {
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    throw new Error("Enter owner/repository or a github.com repository URL.");

  const snapshot = await loadSnapshot(reference, options);
  const analysis = analyzeSnapshot(snapshot, options.now ?? new Date());
  const declaredMergeAuthority = declaredMergeAuthorityFromSnapshot(snapshot);
  return {
    ...analysis,
    declaredMergeAuthority,
    mergeAuthorityConsistency: mergeAuthorityConsistency(
      declaredMergeAuthority,
      snapshot.repository.governance.defaultBranchProtection,
    ),
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
  const defaultBranchObservation = shouldInspectDefaultBranch(repository)
    ? githubOptionalJson(
        `/repos/${reference.owner}/${reference.name}/branches/${encodeURIComponent(repository.default_branch)}`,
        fetchImpl,
        signal,
      )
    : Promise.resolve({
        status: "unavailable",
        reason: "repository-governance-metadata-unavailable",
      });
  const [tree, defaultBranch] = await Promise.all([
    githubJson(
      `/repos/${reference.owner}/${reference.name}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
      fetchImpl,
      signal,
    ),
    defaultBranchObservation,
  ]);
  const entries = (tree.tree ?? []).filter(
    (entry) => entry.path && entry.sha && ["blob", "tree"].includes(entry.type),
  );
  const selectedBase = selectedRemoteFiles(entries);
  const selectedWorkflows = selectedWorkflowFiles(entries);
  const rootAction = entries.find(
    (entry) => entry.type === "blob" && ["action.yml", "action.yaml"].includes(entry.path),
  );
  const selected = [
    ...selectedBase,
    ...selectedWorkflows,
    ...(rootAction && !selectedBase.some((entry) => entry.path === rootAction.path)
      ? [rootAction]
      : []),
  ];
  const eligible = selectedRemoteFiles(entries, entries.length);
  const eligibleWorkflows = selectedWorkflowFiles(entries, entries.length);
  const packageCount = eligible.filter((entry) => entry.path.endsWith("package.json")).length;
  const selectedPackages = selectedBase.filter((entry) =>
    entry.path.endsWith("package.json"),
  ).length;
  const workflowFetchTruncated = selectedWorkflows.length < eligibleWorkflows.length;
  const files = {};
  const unreadablePaths = [];

  await Promise.all(
    selected.map(async (entry) => {
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
        unreadablePaths.push(entry.path);
      }
    }),
  );

  return {
    repository: {
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
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
    manifestFetchTruncated: selectedPackages < packageCount,
    workflowFetchTruncated,
    unreadablePaths: unreadablePaths.toSorted(),
  };
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
    if (!response.ok)
      return { status: "unavailable", reason: `github-http-${response.status}` };
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
