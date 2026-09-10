import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { collectLocalProjectManifestEvidence } from "../src/normalized-evidence.ts";
import {
  collectGithubProjectManifestEvidence,
  createProjectManifestEvidence,
  projectManifestSemantics,
} from "../site/project-evidence.js";
import { analyzeSnapshot } from "../site/preflight.js";

function write(path, content = "\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function blob(path) {
  return { path, type: "blob", sha: path };
}

function snapshot(tree, treeTruncated = false) {
  return {
    repository: {
      name: "fixture",
      fullName: "example/fixture",
      defaultBranch: "main",
    },
    tree,
    files: {
      ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
    },
    treeTruncated,
    manifestFetchTruncated: false,
    workflowFetchTruncated: false,
    unreadablePaths: [],
  };
}

describe("normalized Rust and .NET manifest evidence", () => {
  test("produces equivalent manifest semantics from filesystem and GitHub collectors", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-project-evidence-"));
    write(join(root, "rust", "Cargo.toml"), '[package]\nname = "rust"\nversion = "0.1.0"\n');
    write(join(root, "dotnet", "App.csproj"), "<Project />\n");
    write(join(root, "dotnet", "App.sln"), "\n");

    const localEvidence = collectLocalProjectManifestEvidence(root);
    const remoteSnapshot = snapshot([
      blob("rust/Cargo.toml"),
      blob("rust/src/lib.rs"),
      blob("dotnet/App.csproj"),
      blob("dotnet/App.sln"),
      blob("dotnet/Program.cs"),
      blob(".coding-tooling.json"),
    ]);
    const remoteAnalysis = analyzeSnapshot(remoteSnapshot);
    const remoteEvidence = collectGithubProjectManifestEvidence(
      remoteSnapshot,
      remoteAnalysis.components,
    );

    expect(localEvidence.map((evidence) => evidence.component.kind).toSorted()).toEqual([
      "dotnet",
      "rust",
    ]);
    expect(remoteEvidence.map((evidence) => evidence.component.kind).toSorted()).toEqual([
      "dotnet",
      "rust",
    ]);

    for (const local of localEvidence) {
      const remote = remoteEvidence.find(
        (evidence) =>
          evidence.component.kind === local.component.kind &&
          evidence.component.path === local.component.path,
      );
      expect(remote).toBeDefined();
      expect(projectManifestSemantics(local)).toEqual(projectManifestSemantics(remote));
      expect(
        local.facts.manifests.provenance.every(({ collector }) => collector === "filesystem"),
      ).toBe(true);
      expect(
        remote.facts.manifests.provenance.every(({ collector }) => collector === "github"),
      ).toBe(true);
    }
  });

  test("keeps all same-directory .NET manifests instead of selecting one by traversal order", () => {
    const evidence = createProjectManifestEvidence({
      collector: "github",
      name: "service",
      path: "service",
      kind: "dotnet",
      manifestPaths: ["service/Service.sln", "service/Service.csproj", "service/Service.csproj"],
    });

    expect(evidence.facts.manifests).toEqual({
      status: "available",
      value: ["service/Service.csproj", "service/Service.sln"],
      provenance: [
        { collector: "github", path: "service/Service.csproj" },
        { collector: "github", path: "service/Service.sln" },
      ],
    });
  });

  test("keeps absent manifest facts incomplete rather than satisfied", () => {
    const evidence = createProjectManifestEvidence({
      collector: "github",
      name: "service",
      path: "service",
      kind: "dotnet",
      manifestPaths: [],
    });

    expect(projectManifestSemantics(evidence)).toEqual({
      kind: "dotnet",
      manifestStatus: "incomplete",
      manifestPaths: [],
    });
  });

  test("keeps a discovered manifest incomplete when the GitHub tree is truncated", () => {
    const evidence = collectGithubProjectManifestEvidence(
      snapshot([blob("service/Service.csproj")], true),
      [{ name: "service", path: "service", kind: "dotnet" }],
    )[0];

    expect(projectManifestSemantics(evidence)).toEqual({
      kind: "dotnet",
      manifestStatus: "incomplete",
      manifestPaths: ["service/Service.csproj"],
    });
    expect(evidence.facts.manifests.provenance).toEqual([
      { collector: "github", path: "service/Service.csproj" },
    ]);
  });

  test("ignores GitHub tree entries whose directory names look like manifests", () => {
    const evidence = collectGithubProjectManifestEvidence(
      snapshot([
        { path: "service/Fake.csproj", type: "tree", sha: "fake-tree" },
        blob("service/Real.csproj"),
      ]),
      [{ name: "service", path: "service", kind: "dotnet" }],
    )[0];

    expect(projectManifestSemantics(evidence)).toEqual({
      kind: "dotnet",
      manifestStatus: "available",
      manifestPaths: ["service/Real.csproj"],
    });
  });
});
