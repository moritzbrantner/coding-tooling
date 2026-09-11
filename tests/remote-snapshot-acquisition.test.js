import { describe, expect, test } from "bun:test";

import { loadSnapshot } from "../site/github-analysis.js";
import { analyzeSnapshot } from "../site/preflight.js";

const revision = "a".repeat(40);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function repositoryMetadata() {
  return {
    owner: { login: "example" },
    name: "repo",
    full_name: "example/repo",
    default_branch: "main",
    html_url: "https://github.com/example/repo",
    description: null,
    archived: false,
    fork: false,
    stargazers_count: 0,
    open_issues_count: 0,
    license: null,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    has_pages: true,
  };
}

function branchMetadata() {
  return { name: "main", commit: { sha: revision }, protected: false };
}

function manifest(index) {
  if (index === 0) {
    return {
      name: "root",
      private: true,
      packageManager: "bun@1.4.0",
      workspaces: ["packages/*"],
    };
  }
  return { name: `package-${index}`, private: true };
}

function manifestPath(index) {
  return index === 0 ? "package.json" : `packages/package-${index}/package.json`;
}

describe("immutable remote snapshot acquisition", () => {
  test("loads 28 small manifests from one exact revision without count truncation", async () => {
    const requests = [];
    const entries = Array.from({ length: 28 }, (_, index) => ({
      path: manifestPath(index),
      sha: `blob-${index}`,
      type: "blob",
      size: 256,
    }));

    const snapshot = await loadSnapshot(
      { owner: "example", name: "repo" },
      {
        fetchImpl: async (url) => {
          requests.push(url);
          if (url === "https://api.github.com/repos/example/repo")
            return jsonResponse(repositoryMetadata());
          if (url === "https://api.github.com/repos/example/repo/branches/main")
            return jsonResponse(branchMetadata());
          if (url === `https://api.github.com/repos/example/repo/git/trees/${revision}?recursive=1`)
            return jsonResponse({ tree: entries, truncated: false });
          const match = url.match(/\/git\/blobs\/blob-(\d+)$/);
          if (match) {
            const index = Number(match[1]);
            return jsonResponse({
              encoding: "base64",
              content: btoa(JSON.stringify(manifest(index))),
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    expect(snapshot.repository.revision).toBe(revision);
    expect(snapshot.revisionUnavailable).toBe(false);
    expect(snapshot.manifestFetchTruncated).toBe(false);
    expect(snapshot.manifestAcquisition).toEqual(
      expect.objectContaining({
        reason: "within-byte-budget",
        eligibleCount: 28,
        selectedCount: 28,
        selectedBytes: 28 * 256,
      }),
    );
    expect(Object.keys(snapshot.files)).toHaveLength(28);
    expect(requests).toContain(
      `https://api.github.com/repos/example/repo/git/trees/${revision}?recursive=1`,
    );
    expect(requests).not.toContain(
      "https://api.github.com/repos/example/repo/git/trees/main?recursive=1",
    );
  });

  test("marks the analysis incomplete when exact revision observation fails", async () => {
    const snapshot = await loadSnapshot(
      { owner: "example", name: "repo" },
      {
        fetchImpl: async (url) => {
          if (url === "https://api.github.com/repos/example/repo")
            return jsonResponse(repositoryMetadata());
          if (url === "https://api.github.com/repos/example/repo/branches/main")
            return jsonResponse({}, 503);
          if (url === "https://api.github.com/repos/example/repo/git/trees/main?recursive=1")
            return jsonResponse({ tree: [], truncated: false });
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );
    const analysis = analyzeSnapshot(snapshot);

    expect(snapshot.repository.revision).toBeNull();
    expect(snapshot.revisionUnavailable).toBe(true);
    expect(analysis.summary.status).toBe("incomplete");
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({ id: "REMOTE-SOURCE-004", severity: "medium" }),
    );
  });
});
