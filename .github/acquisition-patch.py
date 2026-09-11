from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new in text:
        return
    raise SystemExit(f"expected patch context missing in {path}")


replace_once(
    "site/preflight.js",
    '''  const incomplete =
    snapshot.treeTruncated ||
    snapshot.manifestFetchTruncated ||
    snapshot.unreadablePaths.length > 0 ||
    validationEvidence.status === "incomplete";
''',
    '''  const incomplete =
    snapshot.treeTruncated ||
    snapshot.revisionUnavailable ||
    snapshot.manifestFetchTruncated ||
    snapshot.unreadablePaths.length > 0 ||
    validationEvidence.status === "incomplete";
''',
)

replace_once(
    "site/preflight.js",
    '''      treeTruncated: snapshot.treeTruncated,
      manifestFetchTruncated: snapshot.manifestFetchTruncated,
      workflowFetchTruncated: Boolean(snapshot.workflowFetchTruncated),
''',
    '''      treeTruncated: snapshot.treeTruncated,
      revisionUnavailable: Boolean(snapshot.revisionUnavailable),
      manifestFetchTruncated: snapshot.manifestFetchTruncated,
      manifestAcquisition: snapshot.manifestAcquisition ?? null,
      workflowFetchTruncated: Boolean(snapshot.workflowFetchTruncated),
''',
)

replace_once(
    "site/preflight.js",
    '''  if (snapshot.treeTruncated)
    add(
      "REMOTE-SOURCE-001",
''',
    '''  if (snapshot.revisionUnavailable)
    add(
      "REMOTE-SOURCE-004",
      "medium",
      "Exact default-branch revision is unavailable",
      "Remote preflight could not establish an immutable default-branch revision before loading repository content.",
      "Treat the remote result as incomplete until exact revision provenance can be observed.",
    );
  if (snapshot.treeTruncated)
    add(
      "REMOTE-SOURCE-001",
''',
)

replace_once(
    "tests/site-preflight.test.js",
    '''  test("still marks a real eligible manifest budget overflow incomplete", async () => {
    const manifests = Array.from({ length: 25 }, (_, index) =>
      blob(`packages/package-${String(index).padStart(2, "0")}/package.json`, `package-${index}`),
    );
''',
    '''  test("still marks a real eligible manifest byte-budget overflow incomplete", async () => {
    const manifests = Array.from({ length: 20 }, (_, index) =>
      blob(
        `packages/package-${String(index).padStart(2, "0")}/package.json`,
        `package-${index}`,
        40 * 1024,
      ),
    );
''',
)

replace_once(
    "tests/site-preflight.test.js",
    '''    expect(snapshot.manifestFetchTruncated).toBe(true);
    expect(Object.keys(snapshot.files)).toHaveLength(24);
''',
    '''    expect(snapshot.manifestFetchTruncated).toBe(true);
    expect(snapshot.manifestAcquisition).toEqual(
      expect.objectContaining({
        reason: "byte-budget-exceeded",
        selectedCount: 12,
        eligibleCount: 20,
      }),
    );
    expect(Object.keys(snapshot.files)).toHaveLength(12);
''',
)

replace_once(
    "tests/site-preflight.test.js",
    '''function blob(path, sha) {
  return { path, sha, type: "blob" };
}
''',
    '''function blob(path, sha, size = 1024) {
  return { path, sha, type: "blob", size };
}
''',
)
