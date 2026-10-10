import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  normalizeProductAcceptance,
  selectMergeVerification,
  validateProductReferences,
  type ProductAcceptance,
} from "../src/agent-product-evidence.ts";
import { normalizeTaskPacket, TASK_PACKET_VERSION, type TaskPacket } from "../src/agent-work.ts";

const roots: string[] = [];
const sha = "0123456789abcdef0123456789abcdef01234567";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-acceptance-"));
  roots.push(root);
  file(
    root,
    "package.json",
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      type: "module",
      scripts: { test: "bun test" },
    }),
  );
  file(root, "docs/approved.md", "Approved behavior\n");
  file(root, "src/feature.ts", "export const feature = 1;\n");
  file(root, "src/other.ts", "export const other = 2;\n");
  file(
    root,
    "tests/feature.test.ts",
    'import { test } from "bun:test";\nimport { feature } from "../src/feature.ts";\ntest("feature", () => { if (!feature) throw Error("bad"); });\n',
  );
  file(
    root,
    "tests/other.test.ts",
    'import { test } from "bun:test";\nimport { other } from "../src/other.ts";\ntest("other", () => { if (!other) throw Error("bad"); });\n',
  );
  return root;
}

function file(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}

function product(revision = sha): ProductAcceptance {
  return {
    specifications: [{ path: "docs/approved.md", revision }],
    contracts: [{ path: "tests/feature.test.ts", revision, capability: "test" }],
    coreSmokeCapabilities: ["test"],
    independentAgentClaim: "reviewer-context",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("preserves v1 task packets and treats independence as an unverified claim", () => {
  const legacy: TaskPacket = {
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Keep behavior",
    baselineSha: sha,
    ownedCapability: "some/feature",
    mustPreserve: [],
    outOfScope: [],
    changeKinds: ["behavior"],
  };
  expect(normalizeTaskPacket(legacy).packet).toEqual(legacy);
  const newPacket = normalizeTaskPacket({
    ...legacy,
    changeKinds: ["architecture"],
    acceptance: { product: product() },
  });
  expect(newPacket.diagnostics).toEqual([]);
  expect(newPacket.packet?.acceptance?.product?.independentAgentClaim).toBe("reviewer-context");
});

test("rejects missing fields, escaping paths and unsupported smoke capabilities", () => {
  const invalid = normalizeProductAcceptance({
    specifications: [{ path: "../private.md", revision: sha }],
    contracts: [{ path: "tests/a.test.ts", revision: "HEAD", capability: "test" }],
    coreSmokeCapabilities: ["benchmark:smoke"],
  });
  expect(invalid.product).toBeUndefined();
  expect(invalid.diagnostics.map((item) => item.code)).toContain("task-product-reference-invalid");
  expect(invalid.diagnostics.map((item) => item.code)).toContain("task-product-smoke-invalid");
  expect(
    normalizeProductAcceptance({ specifications: [], contracts: [], coreSmokeCapabilities: [] })
      .product,
  ).toBeUndefined();
});

test("proves only tests reachable through complete static dependencies", () => {
  const root = fixture();
  const response = { command: ["bun","test"], status: 0, stdout: "", stderr: "" };
  const decision = selectMergeVerification(
    root,
    sha,
    ["src/feature.ts"],
    product(),
    () => response,
  );
  expect(decision.mode).toBe("affected");
  expect(decision.reason).toBe("closed-dependency-graph-covers-changes");
  expect(decision.selectedTests).toEqual(["tests/feature.test.ts"]);
  expect(decision.coreSmokeCapabilities).toEqual(["test"]);
  expect(decision.execution).toBe("not-run");
});

test("falls back to full suite for unknown imports or shared boundaries", () => {
  const root = fixture();
  const runner = () => ({ command: ["bun","test"], status: 0, stdout: "", stderr: "" });
  expect(selectMergeVerification(root, sha, ["package.json"], product(), runner).mode).toBe(
    "full-required",
  );
  file(root, "tests/other.test.ts", 'import "@/unknown";\n');
  expect(selectMergeVerification(root, sha, ["src/feature.ts"], product(), runner).reason).toBe(
    "dependency-graph-incomplete",
  );
  file(root, "tests/other.test.ts", 'import { other } from "../src/other.ts";\n');
  expect(selectMergeVerification(root, sha, ["src/unlinked.ts"], product(), runner).mode).toBe(
    "full-required",
  );
});

test("incomplete or excluded native test discovery cannot select affected tests", () => {
  const root = fixture();
  const runner = () => ({ command: ["bun","test"], status: 1, stdout: "", stderr: "unavailable" });
  expect(selectMergeVerification(root, sha, ["src/feature.ts"], product(), runner).reason).toBe(
    "test-discovery-incomplete",
  );
});

test("rejects stale, missing, non-ancestor and symlink-escaping product references", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  expect(validateProductReferences(root, product(baseline), baseline)).toEqual([]);

  file(root, "docs/approved.md", "Changed approved behavior\n");
  const candidate = commit(root);
  expect(
    validateProductReferences(root, product(baseline), candidate).map((d) => d.code),
  ).toContain("verification-reference-stale");

  const missing = product(candidate);
  missing.contracts[0] = { path: "tests/missing.test.ts", revision: candidate, capability: "test" };
  expect(validateProductReferences(root, missing, candidate).map((d) => d.code)).toContain(
    "verification-reference-unsafe",
  );

  const untracked = product(sha);
  expect(validateProductReferences(root, untracked, candidate).map((d) => d.code)).toContain(
    "verification-reference-revision-invalid",
  );

  const external = mkdtempSync(join(tmpdir(), "agent-reference-outside-"));
  roots.push(external);
  file(external, "secret.md", "private");
  symlinkSync(join(external, "secret.md"), join(root, "docs", "outside.md"));
  const escaped = product(candidate);
  escaped.specifications[0] = { path: "docs/outside.md", revision: candidate };
  expect(validateProductReferences(root, escaped, candidate).map((d) => d.code)).toContain(
    "verification-reference-unsafe",
  );
});
