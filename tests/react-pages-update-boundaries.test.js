import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { analysisJson } from "../site/github-analysis.js";
import { analyzeSnapshot, selectedReactSourceFiles } from "../site/preflight.js";
import { selectReactSourceFilesByByteBudget } from "../site/remote-acquisition.js";
import { projectAnalysis, parseAnalysisQuery } from "../site/analysis-query.js";

const source = readFileSync(
  new URL("../fixtures/react-update-boundaries/violations.tsx", import.meta.url),
  "utf8",
);
const revision = "a".repeat(40);
const blob = (path, size = 64) => ({ path, type: "blob", sha: path, size });
function snapshot() {
  return {
    repository: {
      owner: "example",
      name: "repo",
      fullName: "example/repo",
      defaultBranch: "main",
      revision,
    },
    tree: [blob("package.json"), blob("src/Scene.tsx", source.length)],
    files: {
      "package.json": JSON.stringify({ name: "repo", packageManager: "bun@1.4.0" }),
      "src/Scene.tsx": source,
    },
    unreadablePaths: [],
  };
}

describe("Pages React update-boundary evidence", () => {
  test("uses shared source analysis and ranks concrete state findings before context advisory", () => {
    const report = analyzeSnapshot(snapshot(), new Date("2026-09-29T00:00:00Z"));
    const findings = report.findings.filter((finding) => finding.id.startsWith("REMOTE-REACT-"));
    expect(findings).toHaveLength(3);
    expect(findings.find((finding) => finding.conventionId === "REACT-008").severity).toBe(
      "medium",
    );
    expect(findings.find((finding) => finding.conventionId === "REACT-010").severity).toBe("low");
    expect(findings.every((finding) => finding.location.path === "src/Scene.tsx")).toBeTrue();
    const query = parseAnalysisQuery(new URLSearchParams("view=agent&focus=performance"));
    const projection = projectAnalysis(report, query);
    expect(projection.findings).toHaveLength(3);
    expect(projection.strongestFinding.severity).toBe("medium");
    expect(analyzeSnapshot(snapshot(), new Date("2026-09-29T00:00:00Z"))).toEqual(report);
  });

  test("excludes fixtures, tests, stories, generated outputs and declaration files", () => {
    const tree = [
      "src/Scene.tsx",
      "src/Scene.jsx",
      "src/Scene.test.tsx",
      "src/Scene.stories.tsx",
      "src/types.d.ts",
      "src/testing/Scene.tsx",
      "fixtures/app/src/Scene.tsx",
      "dist/src/Scene.tsx",
    ].map((path) => blob(path));
    expect(selectedReactSourceFiles(tree).map((entry) => entry.path)).toEqual([
      "src/Scene.jsx",
      "src/Scene.tsx",
    ]);
  });

  test("exposes byte-budget and unreadable-source limitations without claiming clean analysis", () => {
    const selection = selectReactSourceFilesByByteBudget([blob("src/Scene.tsx", 100)], 99);
    expect(selection.complete).toBeFalse();
    expect(selection.reason).toBe("byte-budget-exceeded");
    expect(selection.selected).toEqual([]);
    const partial = snapshot();
    partial.reactSourceFetchTruncated = true;
    expect(analyzeSnapshot(partial).summary.status).toBe("incomplete");
    delete partial.reactSourceFetchTruncated;
    partial.unreadableReactSourcePaths = ["src/Scene.tsx"];
    delete partial.files["src/Scene.tsx"];
    const report = analyzeSnapshot(partial);
    expect(report.summary.status).toBe("incomplete");
    expect(report.source.unreadableReactSourcePaths).toEqual(["src/Scene.tsx"]);
  });

  test("loads React source from the pinned GitHub snapshot and analyzes it through the public seam", async () => {
    const data = snapshot();
    const requested = [];
    const result = await analysisJson("example/repo", {
      now: new Date("2026-09-29T00:00:00Z"),
      fetchImpl: async (url) => {
        requested.push(url);
        let value;
        if (url === "https://api.github.com/repos/example/repo")
          value = {
            owner: { login: "example" },
            name: "repo",
            full_name: "example/repo",
            default_branch: "main",
            allow_merge_commit: true,
            html_url: "https://github.com/example/repo",
          };
        else if (url.endsWith("/branches/main")) value = { commit: { sha: revision } };
        else if (url.includes(`/git/trees/${revision}?recursive=1`)) value = { tree: data.tree };
        else if (url.includes("/git/blobs/"))
          value = { encoding: "base64", content: btoa(data.files[url.split("/git/blobs/")[1]]) };
        else return new Response("{}", { status: 404 });
        return new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    expect(
      result.findings.filter((finding) => finding.id.startsWith("REMOTE-REACT-")),
    ).toHaveLength(3);
    expect(result.source.reactSourceAcquisition.selectedCount).toBe(1);
    expect(result.source.reactSourceFetchTruncated).toBeFalse();
    expect(requested.some((url) => url.includes(`/git/trees/${revision}`))).toBeTrue();
  });
});
