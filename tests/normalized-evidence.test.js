import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { collectLocalPackageEvidence } from "../src/normalized-evidence.ts";
import {
  canonicalPackageCapabilityOutcomes,
  packageCommandManager,
  packageSemantics,
  packageToolchainOutcome,
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
    expect(packageToolchainOutcome(localEvidence)).toEqual({
      ...packageToolchainOutcome(remoteEvidence),
      provenance: packageToolchainOutcome(localEvidence).provenance,
    });
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

  test("does not inherit a root Bun lock into an unrelated nested package", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-normalized-nested-"));
    writeJson(join(root, "package.json"), {
      name: "root",
      packageManager: "bun@1.4.0",
      scripts: { lint: "lint" },
    });
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
          "package.json": JSON.stringify({
            name: "root",
            packageManager: "bun@1.4.0",
            scripts: { lint: "lint" },
          }),
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
    );

    expect(localNested.facts.lockfiles.value).toEqual([]);
    expect(remoteNested.evidence.facts.lockfiles.value).toEqual([]);
    expect(packageCommandManager(localNested)).toBe("npm");
    expect(packageCommandManager(remoteNested.evidence)).toBe("npm");
    expect(packageToolchainOutcome(localNested).status).toBe("incomplete");
    expect(remoteNested.toolchain.status).toBe("incomplete");
    expect(remoteNested.capabilities.lint).toEqual(["npm", "run", "lint"]);
    expect(
      analysis.findings.some(
        (finding) =>
          finding.id.startsWith("REMOTE-ENV-006-") && finding.title.startsWith("nested:"),
      ),
    ).toBe(true);
  });

  test("uses a nested component-local Node pin without inheriting root toolchain evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-normalized-node-"));
    writeJson(join(root, "package.json"), {
      name: "root",
      packageManager: "bun@1.4.0",
      scripts: { lint: "lint" },
    });
    writeFileSync(join(root, "bun.lock"), "root\n");
    writeJson(join(root, "packages", "nested", "package.json"), {
      name: "nested",
      scripts: { lint: "lint" },
    });
    writeFileSync(join(root, "packages", "nested", ".node-version"), "24.20.0\n");
    writeFileSync(join(root, "packages", "nested", "package-lock.json"), "{}\n");

    const localNested = collectLocalPackageEvidence(root).find(
      (evidence) => evidence.component.path === "packages/nested",
    );
    const analysis = analyzeSnapshot(
      snapshot(
        [
          blob("package.json"),
          blob("bun.lock"),
          blob("packages/nested/package.json"),
          blob("packages/nested/.node-version"),
          blob("packages/nested/package-lock.json"),
          blob(".coding-tooling.json"),
          blob(".github/workflows/validate.yml"),
        ],
        {
          "package.json": JSON.stringify({
            name: "root",
            packageManager: "bun@1.4.0",
            scripts: { lint: "lint" },
          }),
          "packages/nested/package.json": JSON.stringify({
            name: "nested",
            scripts: { lint: "lint" },
          }),
          "packages/nested/.node-version": "24.20.0\n",
          ".coding-tooling.json": JSON.stringify({ schemaVersion: 1 }),
        },
      ),
    );
    const remoteNested = analysis.components.find(
      (component) => component.path === "packages/nested",
    );

    expect(packageToolchainOutcome(localNested)).toEqual({
      status: "satisfied",
      manager: "npm",
      runtime: "node",
      version: "24.20.0",
      reason: "exact-node-version",
      provenance: [{ collector: "filesystem", path: "packages/nested/.node-version" }],
    });
    expect(remoteNested.toolchain).toEqual({
      status: "satisfied",
      manager: "npm",
      runtime: "node",
      version: "24.20.0",
      reason: "exact-node-version",
      provenance: [{ collector: "github", path: "packages/nested/.node-version" }],
    });
  });
});
