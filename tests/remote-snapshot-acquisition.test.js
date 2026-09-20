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

  test("pins an explicit ref to one exact revision before reading the tree", async () => {
    const pinnedRevision = "b".repeat(40);
    const requests = [];
    const snapshot = await loadSnapshot(
      { owner: "example", name: "repo" },
      {
        ref: "feature",
        fetchImpl: async (url) => {
          requests.push(url);
          if (url === "https://api.github.com/repos/example/repo")
            return jsonResponse(repositoryMetadata());
          if (url === "https://api.github.com/repos/example/repo/branches/main")
            return jsonResponse(branchMetadata());
          if (url === "https://api.github.com/repos/example/repo/commits/feature")
            return jsonResponse({ sha: pinnedRevision });
          if (
            url ===
            `https://api.github.com/repos/example/repo/git/trees/${pinnedRevision}?recursive=1`
          )
            return jsonResponse({ tree: [], truncated: false });
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    expect(snapshot.repository.requestedRef).toBe("feature");
    expect(snapshot.repository.revision).toBe(pinnedRevision);
    expect(snapshot.revisionUnavailable).toBe(false);
    expect(requests).toContain(
      `https://api.github.com/repos/example/repo/git/trees/${pinnedRevision}?recursive=1`,
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

  test("loads bounded Rust sources and resolves public reusable workflows at an exact ref", async () => {
    const reusableRef = "b".repeat(40);
    const caller = `on:
  pull_request:
jobs:
  validate:
    uses: owner/reusable/.github/workflows/validate.yml@${reusableRef}
    with:
      test_command: cargo test --locked
`;
    const reusable = `on:
  workflow_call:
    inputs:
      test_command:
        type: string
jobs:
  validate:
    steps:
      - run: \${{ inputs.test_command }}
`;
    const entries = [
      { path: "Cargo.toml", sha: "cargo", type: "blob", size: 100 },
      { path: "src/lib.rs", sha: "rust-source", type: "blob", size: 200 },
      {
        path: ".github/workflows/validate.yml",
        sha: "caller-workflow",
        type: "blob",
        size: 300,
      },
    ];
    const requests = [];

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
          if (url === "https://api.github.com/repos/example/repo/git/blobs/cargo")
            return jsonResponse({
              encoding: "base64",
              content: btoa('[workspace]\nmembers = ["crates/world"]\n'),
            });
          if (url === "https://api.github.com/repos/example/repo/git/blobs/rust-source")
            return jsonResponse({
              encoding: "base64",
              content: btoa("pub fn tick() {}\n#[cfg(test)]\nmod tests {}\n"),
            });
          if (url === "https://api.github.com/repos/example/repo/git/blobs/caller-workflow")
            return jsonResponse({ encoding: "base64", content: btoa(caller) });
          if (
            url ===
            `https://api.github.com/repos/owner/reusable/contents/.github/workflows/validate.yml?ref=${reusableRef}`
          )
            return jsonResponse({ type: "file", encoding: "base64", content: btoa(reusable) });
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );

    expect(snapshot.files["src/lib.rs"]).toContain("#[cfg(test)]");
    expect(snapshot.rustSourceAcquisition).toEqual(
      expect.objectContaining({ selectedCount: 1, selectedBytes: 200 }),
    );
    expect(snapshot.rustSourceFetchTruncated).toBe(false);
    expect(snapshot.reusableWorkflows).toEqual([
      expect.objectContaining({
        status: "resolved",
        repository: "owner/reusable",
        ref: reusableRef,
        path: ".github/workflows/validate.yml",
        content: reusable,
      }),
    ]);
    expect(requests).toContain(
      `https://api.github.com/repos/owner/reusable/contents/.github/workflows/validate.yml?ref=${reusableRef}`,
    );
  });
});
