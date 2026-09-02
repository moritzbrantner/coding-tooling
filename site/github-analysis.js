import { analyzeSnapshot, parseRepositoryReference, selectedRemoteFiles } from "./preflight.js";

export async function analysisJson(value, options = {}) {
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    throw new Error("Enter owner/repository or a github.com repository URL.");

  const snapshot = await loadSnapshot(reference, options);
  return analyzeSnapshot(snapshot, options.now ?? new Date());
}

export async function loadSnapshot(reference, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
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
  const entries = (tree.tree ?? []).filter(
    (entry) => entry.path && entry.sha && ["blob", "tree"].includes(entry.type),
  );
  const selected = selectedRemoteFiles(entries);
  const packageCount = entries.filter(
    (entry) => entry.type === "blob" && entry.path.endsWith("package.json"),
  ).length;
  const selectedPackages = selected.filter((entry) => entry.path.endsWith("package.json")).length;
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
    },
    tree: entries,
    files,
    treeTruncated: Boolean(tree.truncated),
    manifestFetchTruncated: selectedPackages < packageCount,
    unreadablePaths: unreadablePaths.toSorted(),
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

function decodeBase64(value) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/\n/g, "")), (character) => character.charCodeAt(0)),
  );
}
