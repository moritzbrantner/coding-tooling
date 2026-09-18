export async function resolveRequestedRevision(reference, ref, loadJson) {
  const commit = await loadJson(
    `/repos/${reference.owner}/${reference.name}/commits/${encodeURIComponent(ref)}`,
  );
  const sha = commit?.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha ?? ""))
    throw new Error(`GitHub did not resolve ref to an exact commit SHA: ${ref}`);
  return sha;
}
