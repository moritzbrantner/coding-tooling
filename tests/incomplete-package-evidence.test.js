import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  collectLocalPackageEvidence,
  collectLocalProjectManifestEvidence,
} from "../src/normalized-evidence.ts";
import { discoverComponents } from "../src/core.ts";
import { canonicalPackageCapabilityOutcomes } from "../site/evidence-model.js";
import { analyzeSnapshot } from "../site/preflight.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function snapshot(tree, files = {}) {
  return {
    repository: { name: "fixture", fullName: "example/fixture", defaultBranch: "main" },
    tree,
    files,
    treeTruncated: false,
    manifestFetchTruncated: false,
    unreadablePaths: [],
  };
}
function blob(path) {
  return { path, type: "blob", sha: path };
}

describe("normalized manifest acquisition gaps", () => {
  test("an unreadable package remains a component with incomplete canonical evidence", () => {
    const analysis = analyzeSnapshot(snapshot([blob("package.json"), blob("src/index.ts")]));
    expect(analysis.components).toHaveLength(1);
    const component = analysis.components[0];
    expect(component.evidence.facts.manifest.status).toBe("incomplete");
    expect(component.evidence.facts.scripts.status).toBe("incomplete");
    expect(
      canonicalPackageCapabilityOutcomes(component.evidence).every(
        (item) => item.status === "incomplete",
      ),
    ).toBeTrue();
    expect(analysis.summary.status).toBe("incomplete");
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({ title: "fixture conventional script evidence is incomplete" }),
    );
  });
  test("malformed manifests have equivalent local and remote unknown outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-malformed-package-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{ broken");
    const local = collectLocalPackageEvidence(root)[0];
    const remote = analyzeSnapshot(snapshot([blob("package.json")], { "package.json": "{ broken" }))
      .components[0].evidence;
    expect(local.facts.manifest.status).toBe("incomplete");
    expect(canonicalPackageCapabilityOutcomes(local).map(({ status }) => status)).toEqual(
      canonicalPackageCapabilityOutcomes(remote).map(({ status }) => status),
    );
    expect(
      canonicalPackageCapabilityOutcomes(local).every(({ status }) => status === "incomplete"),
    ).toBeTrue();
  });
  test("directory names cannot create components, and symlink manifest bytes are unavailable", () => {
    const tree = ["package.json", "Cargo.toml", "Fake.csproj"].map((path) => ({
      path,
      type: "tree",
      sha: path,
    }));
    expect(analyzeSnapshot(snapshot(tree)).components).toEqual([]);
    const linked = { ...blob("package.json"), mode: "120000" };
    const analysis = analyzeSnapshot(
      snapshot([linked], { "package.json": '{"name":"forged","scripts":{"test":"true"}}' }),
    );
    expect(analysis.components[0].evidence.facts.manifest.status).toBe("incomplete");
    expect(
      canonicalPackageCapabilityOutcomes(analysis.components[0].evidence).some(
        ({ status }) => status === "satisfied",
      ),
    ).toBeFalse();
  });
  test("a valid known-empty manifest remains distinct from unavailable acquisition", () => {
    const analysis = analyzeSnapshot(snapshot([blob("package.json")], { "package.json": "{}" }));
    expect(analysis.components[0].evidence.facts.manifest.status).toBe("available");
    expect(
      canonicalPackageCapabilityOutcomes(analysis.components[0].evidence).every(
        ({ status }) => status === "finding",
      ),
    ).toBeTrue();
  });

  test("local discovery does not follow a linked manifest or supply runnable capabilities", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-linked-package-"));
    const outside = mkdtempSync(join(tmpdir(), "coding-tooling-linked-package-outside-"));
    roots.push(root, outside);
    const target = join(outside, "manifest.json");
    writeFileSync(target, '{"name":"external","scripts":{"test":"exit 99"}}');
    symlinkSync(target, join(root, "package.json"), "file");
    expect(discoverComponents(root)).toEqual([]);
    const [evidence] = collectLocalPackageEvidence(root);
    expect(evidence.facts.manifest.status).toBe("incomplete");
    expect(evidence.facts.scripts.value).toEqual({});
  });

  test("an unreadable workspace member cannot inherit a satisfied root toolchain", () => {
    const analysis = analyzeSnapshot(
      snapshot([blob("package.json"), blob("packages/app/package.json")], {
        "package.json": '{"name":"root","packageManager":"bun@1.4.2","workspaces":["packages/*"]}',
      }),
    );
    const member = analysis.components.find((component) => component.path === "packages/app");
    expect(member.workspace.status).toBe("satisfied");
    expect(member.toolchain.status).toBe("incomplete");
    expect(member.toolchain.inheritedFrom).toBeUndefined();
  });

  test("linked native manifests retain incomplete provenance rather than known manifest evidence", () => {
    for (const path of ["Cargo.toml", "App.csproj"]) {
      const analysis = analyzeSnapshot(snapshot([{ ...blob(path), mode: "120000" }]));
      expect(analysis.components[0].projectEvidence.facts.manifests.status).toBe("incomplete");
      expect(analysis.summary.status).toBe("incomplete");
    }
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-linked-native-"));
    const outside = mkdtempSync(join(tmpdir(), "coding-tooling-linked-native-outside-"));
    roots.push(root, outside);
    writeFileSync(join(root, "App.csproj"), "<Project />");
    const target = join(outside, "External.sln");
    writeFileSync(target, "external solution");
    symlinkSync(target, join(root, "Linked.sln"), "file");
    const [local] = collectLocalProjectManifestEvidence(root);
    expect(local.facts.manifests.status).toBe("incomplete");
    expect(local.facts.manifests.value).toEqual(["App.csproj", "Linked.sln"]);
  });
});
