import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { collectLocalPackageEvidence } from "../src/normalized-evidence.ts";
import {
  canonicalPackageCapabilityOutcomes,
  packageSemantics,
} from "../site/evidence-model.js";
import { analyzeSnapshot } from "../site/preflight.js";

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function blob(path, sha = path) {
  return { path, type: "blob", sha };
}

function snapshot(tree, files) {
  return {
    repository: {
      name: "fixture",
      fullName: "example/fixture",
      defaultBranch: "main",
    },
    tree,
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
  };
}

function packageManifest() {
  return {
    name: "fixture",
    packageManager: "bun@1.4.0",
    scripts: {
      "format:check": "oxfmt --check .",
      lint: "oxlint .",
      typecheck: "tsc --noEmit",
      test: "bun test",
      "profile:runtime": "runtime-profiler capture runtime.json",
    },
    dependencies: {
      react: "19.0.0",
      vite: "7.0.0",
    },
    devDependencies: {
      lighthouse: "13.0.0",
      typescript: "7.0.2",
    },
  };
}

describe("normalized package evidence", () => {
  test("produces equivalent pure package semantics from local and GitHub collectors", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-normalized-evidence-"));
    const manifest = packageManifest();
    writeJson(join(root, "package.json"), manifest);
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "bun.lock"), "fixture\n");

    const [localEvidence] = collectLocalPackageEvidence(root);
    const analysis = analyzeSnapshot(
      snapshot(
        [
          blob("package.json"),
          blob("tsconfig.json"),
          blob("bun.lock"),
          blob("src/index.ts"),
          blob("tests/index.test.ts"),
          blob(".coding-tooling.json"),
          blob("AGENTS.md"),
          blob("renovate.json"),
          blob(".github/workflows/validate.yml"),
        ],
        {
          "package.json": JSON.stringify(manifest),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      ),
    );
    const remoteEvidence = analysis.components[0].evidence;

    expect(localEvidence.schemaVersion).toBe(1);
    expect(remoteEvidence.schemaVersion).toBe(1);
    expect(localEvidence.facts.manifest.provenance.collector).toBe("filesystem");
    expect(remoteEvidence.facts.manifest.provenance.collector).toBe("github");
    expect(packageSemantics(localEvidence)).toEqual(packageSemantics(remoteEvidence));
    expect(
      canonicalPackageCapabilityOutcomes(localEvidence).map(({ capability, status, script }) => ({
        capability,
        status,
        script,
      })),
    ).toEqual(
      canonicalPackageCapabilityOutcomes(remoteEvidence).map(({ capability, status, script }) => ({
        capability,
        status,
        script,
      })),
    );
  });

  test("keeps nested lock ownership component-scoped in both evidence collectors", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-normalized-nested-"));
    writeJson(join(root, "package.json"), { name: "root", scripts: { lint: "lint" } });
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeJson(join(root, "packages", "nested", "package.json"), {
      name: "nested",
      scripts: { lint: "lint" },
    });

    const localNested = collectLocalPackageEvidence(root).find(
      (evidence) => evidence.component.path === "packages/nested",
    );
    const analysis = analyzeSnapshot(
      snapshot(
        [
          blob("package.json"),
          blob("bun.lock"),
          blob("packages/nested/package.json"),
          blob(".coding-tooling.json"),
          blob(".github/workflows/validate.yml"),
        ],
        {
          "package.json": JSON.stringify({ name: "root", scripts: { lint: "lint" } }),
          "packages/nested/package.json": JSON.stringify({
            name: "nested",
            scripts: { lint: "lint" },
          }),
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      ),
    );
    const remoteNested = analysis.components.find(
      (component) => component.path === "packages/nested",
    ).evidence;

    expect(localNested.facts.lockfiles.value).toEqual([]);
    expect(remoteNested.facts.lockfiles.value).toEqual([]);
    expect(localNested.facts.packageManager.status).toBe("incomplete");
    expect(remoteNested.facts.packageManager.status).toBe("incomplete");
  });
});
