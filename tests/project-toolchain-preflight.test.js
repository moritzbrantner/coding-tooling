import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { analyzeSnapshot, selectedRemoteFiles } from "../site/preflight.js";
import { collectLocalProjectToolchainEvidence } from "../src/normalized-evidence.ts";
import {
  collectGithubProjectToolchainEvidence,
  projectToolchainOutcome,
  projectToolchainPaths,
} from "../site/project-toolchain.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function snapshot(files, treeTruncated = false) {
  return {
    repository: { name: "fixture", fullName: "example/fixture", defaultBranch: "main" },
    tree: Object.keys(files).map((path) => ({ path, type: "blob", sha: path })),
    files: Object.fromEntries(Object.entries(files).filter(([, value]) => value !== null)),
    treeTruncated,
    manifestFetchTruncated: false,
    unreadablePaths: [],
  };
}
function nativeSnapshot(extra = {}, truncated = false) {
  return snapshot(
    {
      "Cargo.toml": '[workspace]\nmembers=["services/rust"]\n',
      "services/rust/Cargo.toml": '[package]\nname="rust"\nversion="0.1.0"\n',
      "services/dotnet/App.csproj": "<Project />",
      "rust-toolchain.toml": '[toolchain]\nchannel="1.98.1"\n',
      "global.json": JSON.stringify({ sdk: { version: "10.0.401", rollForward: "disable" } }),
      ...extra,
    },
    truncated,
  );
}
describe("component-scoped native toolchain declarations", () => {
  test("collectors agree on nearest native declarations and retain their provenance", () => {
    const remote = nativeSnapshot({
      "services/rust/rust-toolchain.toml": '[toolchain]\nchannel="1.97.0"\n',
    });
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-native-toolchains-"));
    roots.push(root);
    for (const [path, content] of Object.entries(remote.files)) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const components = analyzeSnapshot(remote).components;
    const github = collectGithubProjectToolchainEvidence(remote, components);
    const local = collectLocalProjectToolchainEvidence(root);
    for (const evidence of local) {
      const matching = github.find(
        (item) =>
          item.component.path === evidence.component.path &&
          item.component.kind === evidence.component.kind,
      );
      const { provenance: localProvenance, ...localOutcome } = projectToolchainOutcome(evidence);
      const { provenance: remoteProvenance, ...remoteOutcome } = projectToolchainOutcome(matching);
      expect(localOutcome).toEqual(remoteOutcome);
      expect(localProvenance.map((item) => item.path)).toEqual(
        remoteProvenance.map((item) => item.path),
      );
      expect(localProvenance.every((item) => item.collector === "filesystem")).toBeTrue();
    }
    const rust = components.find((item) => item.path === "services/rust");
    expect(rust.toolchain).toMatchObject({
      status: "satisfied",
      version: "1.97.0",
      declaration: "services/rust/rust-toolchain.toml",
    });
    const dotnet = components.find((item) => item.kind === "dotnet");
    expect(dotnet.toolchain).toMatchObject({
      status: "satisfied",
      runtime: "dotnet",
      version: "10.0.401",
      inheritedFrom: ".",
    });
    expect(rust.projectEvidence.facts.manifests.provenance).toContainEqual({
      collector: "github",
      path: "services/rust/Cargo.toml",
    });
  });
  test("a nested override cannot be hidden by a repository root pin", () => {
    const analysis = analyzeSnapshot(
      nativeSnapshot({ "services/rust/rust-toolchain.toml": '[toolchain]\nchannel="stable"\n' }),
    );
    expect(analysis.components.find((item) => item.path === ".").toolchain.status).toBe(
      "satisfied",
    );
    expect(
      analysis.components.find((item) => item.path === "services/rust").toolchain,
    ).toMatchObject({ status: "finding", reason: "project-toolchain-not-exact" });
    expect(
      analysis.findings.some(
        (item) => item.id.startsWith("REMOTE-ENV-004-") && item.title.startsWith("rust:"),
      ),
    ).toBeTrue();
  });
  test("unreadable nearer files and truncated trees stay incomplete", () => {
    for (const source of [
      nativeSnapshot({ "services/rust/rust-toolchain.toml": null }),
      nativeSnapshot({}, true),
    ]) {
      const analysis = analyzeSnapshot(source);
      expect(
        analysis.components.find((item) => item.path === "services/rust").toolchain.status,
      ).toBe("incomplete");
      expect(analysis.summary.status).toBe("incomplete");
    }
  });
  test("legacy Rust precedence and custom toolchains remain explicit", () => {
    const analysis = analyzeSnapshot(
      nativeSnapshot({
        "services/rust/rust-toolchain": "1.96.0\n",
        "services/rust/rust-toolchain.toml": '[toolchain]\nchannel="stable"\n',
      }),
    );
    expect(
      analysis.components.find((item) => item.path === "services/rust").toolchain,
    ).toMatchObject({
      status: "satisfied",
      version: "1.96.0",
      declaration: "services/rust/rust-toolchain",
    });
    const custom = analyzeSnapshot(
      nativeSnapshot({ "services/rust/rust-toolchain.toml": '[toolchain]\npath="/opt/custom"\n' }),
    );
    expect(custom.components.find((item) => item.path === "services/rust").toolchain.status).toBe(
      "unsupported",
    );
  });
  test("unsupported TOML shapes and .NET roll-forward never become exact pins", () => {
    const analysis = analyzeSnapshot(
      nativeSnapshot({
        "rust-toolchain.toml": 'toolchain={channel="1.98.1"}\n',
        "global.json": JSON.stringify({ sdk: { version: "10.0.401", rollForward: "latestPatch" } }),
      }),
    );
    expect(analysis.components.find((item) => item.path === ".").toolchain.status).toBe(
      "unsupported",
    );
    expect(analysis.components.find((item) => item.kind === "dotnet").toolchain).toMatchObject({
      status: "finding",
      reason: "dotnet-sdk-roll-forward-enabled",
    });
  });
  test("selects nested native declarations and does not use sibling pins", () => {
    const source = snapshot({
      "a/Cargo.toml": "[package]\nname='a'\n",
      "a/rust-toolchain.toml": '[toolchain]\nchannel="1.98.1"\n',
      "b/Cargo.toml": "[package]\nname='b'\n",
      "b/App.csproj": "<Project />",
      "a/global.json": '{"sdk":{"version":"10.0.401","rollForward":"disable"}}',
    });
    expect(selectedRemoteFiles(source.tree).map((item) => item.path)).toContain(
      "a/rust-toolchain.toml",
    );
    expect(selectedRemoteFiles(source.tree).map((item) => item.path)).toContain("a/global.json");
    const components = analyzeSnapshot(source).components.filter((item) => item.path === "b");
    expect(
      components.every(
        (item) =>
          item.toolchain.status === "finding" &&
          item.toolchain.reason === "project-toolchain-missing",
      ),
    ).toBeTrue();
  });

  test("bounded TOML cannot mistake comments, strings or invalid line structure for a pin", () => {
    for (const content of [
      '[toolchain]\n# channel="1.98.1"\nprofile="minimal"\n',
      '[toolchain]\ncomponents="""\nchannel="1.98.1"\n"""\n',
      '[toolchain] channel="1.98.1"\n',
      '[toolchain]\nchannel="1.98.1" profile="minimal"\n',
      '[toolchain]\nchannel="1.98.1"\nchannel="stable"\n',
    ]) {
      const analysis = analyzeSnapshot(nativeSnapshot({ "rust-toolchain.toml": content }));
      expect(analysis.components.find((item) => item.path === ".").toolchain.status).toBe(
        "unsupported",
      );
    }
    const valid = analyzeSnapshot(
      nativeSnapshot({
        "rust-toolchain.toml":
          "# channel='stable'\n[toolchain] # declaration\nchannel='1.98.1' # exact\ncomponents=[\n 'rustfmt',\n 'clippy',\n]\n",
      }),
    );
    expect(valid.components.find((item) => item.path === ".").toolchain.status).toBe("satisfied");
  });

  test("local declaration collection refuses symlinks across its boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-toolchain-link-"));
    const outside = mkdtempSync(join(tmpdir(), "coding-tooling-toolchain-outside-"));
    roots.push(root, outside);
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
    const target = join(outside, "toolchain.toml");
    writeFileSync(target, '[toolchain]\nchannel="1.98.1"\n');
    symlinkSync(target, join(root, "rust-toolchain.toml"), "file");
    const [evidence] = collectLocalProjectToolchainEvidence(root);
    expect(projectToolchainOutcome(evidence).status).toBe("incomplete");
    expect(evidence.facts.declarations.value).toEqual([
      { path: "rust-toolchain.toml", content: null },
    ]);
    expect(() => projectToolchainPaths("../outside", "rust")).toThrow("repository-relative");
  });

  test("GitHub symlink blobs cannot masquerade as a legacy version declaration", () => {
    const source = nativeSnapshot({ "rust-toolchain": "1.98.1" });
    source.tree.find((entry) => entry.path === "rust-toolchain").mode = "120000";
    const analysis = analyzeSnapshot(source);
    expect(analysis.components.find((item) => item.path === ".").toolchain.status).toBe(
      "incomplete",
    );
    const before = collectGithubProjectToolchainEvidence(source, analysis.components);
    source.tree = source.tree.toReversed();
    expect(collectGithubProjectToolchainEvidence(source, analysis.components.toReversed())).toEqual(
      before,
    );
  });
});
