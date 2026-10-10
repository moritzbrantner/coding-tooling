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
import {
  agentHandoffCommand,
  agentVerificationCommand,
  normalizeTaskPacket,
  TASK_PACKET_VERSION,
  type TaskPacket,
} from "../src/agent-work.ts";
import { collectTestDiscoveryEvidence } from "../src/test-discovery-evidence.ts";
import { SOURCE_REVISION_ENV, SOURCE_ROOT_ENV } from "../src/source-context.ts";

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
  const response = { command: ["bun", "test"], status: 0, stdout: "", stderr: "" };
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

test("separately declared test capabilities require full verification", () => {
  const root = fixture();
  file(
    root,
    ".coding-tooling.json",
    JSON.stringify({
      schemaVersion: 1,
      capabilityCommands: { ".": { "test:e2e": ["bun", "test", "tests/other.test.ts"] } },
    }),
  );
  const runner = () => ({ command: ["bun", "test"], status: 0, stdout: "", stderr: "" });
  const decision = selectMergeVerification(root, sha, ["src/feature.ts"], product(), runner);
  expect(decision.mode).toBe("full-required");
  expect(decision.reason).toBe("additional-test-capabilities-unmapped");
});

test("falls back to full suite for unknown imports or shared boundaries", () => {
  const root = fixture();
  const runner = () => ({ command: ["bun", "test"], status: 0, stdout: "", stderr: "" });
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
  const runner = () => ({ command: ["bun", "test"], status: 1, stdout: "", stderr: "unavailable" });
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

test("rejects an approved-specification edit as unproven affected-test scope", () => {
  const root = fixture();
  const runner = () => ({ command: ["bun", "test"], status: 0, stdout: "", stderr: "" });
  const decision = selectMergeVerification(root, sha, ["docs/approved.md"], product(), runner);
  expect(decision.mode).toBe("full-required");
  expect(decision.reason).toBe("approved-specification-changed");
});

test("checks requested test membership beyond the 50-file discovery display cap", () => {
  const root = fixture();
  for (let index = 0; index < 55; index += 1) {
    file(
      root,
      `tests/extra-${String(index).padStart(2, "0")}.test.ts`,
      'import { test } from "bun:test";\n',
    );
  }
  file(root, "tests/zz-last.test.ts", 'import { test } from "bun:test";\n');
  const discovery = collectTestDiscoveryEvidence(
    {
      cwd: root,
      capability: "test",
      command: ["bun", "test"],
      requiredFiles: ["tests/zz-last.test.ts", "tests/not-present.test.ts"],
    },
    () => ({ command: ["bun", "test", "--dry-run"], status: 0, stdout: "", stderr: "" }),
  );
  expect(discovery?.status).toBe("available");
  expect(discovery?.truncated).toBe(true);
  expect(discovery?.discoveredFiles).not.toContain("tests/zz-last.test.ts");
  expect(discovery?.provenRequestedFiles).toEqual(["tests/zz-last.test.ts"]);
});

test("unknown mock loaders prevent affected-test selection", () => {
  const root = fixture();
  file(root, "tests/other.test.ts", 'vi.mock("../src/feature.ts", () => ({}));\n');
  const decision = selectMergeVerification(root, sha, ["src/feature.ts"], product(), () => ({
    command: ["bun", "test"],
    status: 0,
    stdout: "",
    stderr: "",
  }));
  expect(decision.mode).toBe("full-required");
  expect(decision.reason).toBe("dependency-graph-incomplete");
});

test("rejects a descendant baseline rather than deriving an empty three-dot diff", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const candidate = commit(root);
  file(root, "src/feature.ts", "export const feature = 3;\n");
  const descendant = commit(root);
  git(root, "checkout", "--detach", candidate);
  file(
    root,
    ".git/task.json",
    JSON.stringify({
      schemaVersion: TASK_PACKET_VERSION,
      goal: "Keep approved behavior",
      baselineSha: descendant,
      ownedCapability: "example/feature",
      mustPreserve: [],
      outOfScope: [],
      changeKinds: ["behavior"],
      acceptance: { product: product(candidate) },
    }),
  );
  const result = agentVerificationCommand(root, ".git/task.json");
  expect(result.status).toBe("unavailable");
  expect(result.diagnostics.map((item) => item.code)).toContain(
    "verification-baseline-not-ancestor",
  );
});

test("capability failures remain failures when acceptance membership is unavailable", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  file(
    root,
    "package.json",
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      type: "module",
      scripts: { test: "exit 12" },
    }),
  );
  const baseline = commit(root);
  file(
    root,
    ".git/task.json",
    JSON.stringify({
      schemaVersion: TASK_PACKET_VERSION,
      goal: "Keep approved behavior",
      baselineSha: baseline,
      ownedCapability: "example/feature",
      mustPreserve: [],
      outOfScope: [],
      changeKinds: ["behavior"],
      acceptance: { product: product(baseline) },
    }),
  );
  const result = agentVerificationCommand(root, ".git/task.json");
  expect(result.status).toBe("failed");
  expect(result.diagnostics.map((item) => item.code)).toContain(
    "verification-acceptance-test-unproven",
  );
});

test("post-check checkout is verified independently of the injected source SHA", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  file(
    root,
    "package.json",
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      type: "module",
      scripts: { test: `git checkout --detach ${baseline}` },
    }),
  );
  const candidate = commit(root);
  file(
    root,
    ".git/task.json",
    JSON.stringify({
      schemaVersion: TASK_PACKET_VERSION,
      goal: "Keep approved behavior",
      baselineSha: baseline,
      ownedCapability: "example/feature",
      mustPreserve: [],
      outOfScope: [],
      changeKinds: ["behavior"],
      acceptance: { product: product(baseline) },
    }),
  );
  const oldSha = process.env[SOURCE_REVISION_ENV];
  const oldRoot = process.env[SOURCE_ROOT_ENV];
  process.env[SOURCE_REVISION_ENV] = candidate;
  process.env[SOURCE_ROOT_ENV] = root;
  try {
    const result = agentVerificationCommand(root, ".git/task.json");
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics.map((item) => item.code)).toContain("verification-head-moved");
    expect(git(root, "rev-parse", "HEAD")).toBe(baseline);
  } finally {
    if (oldSha === undefined) delete process.env[SOURCE_REVISION_ENV];
    else process.env[SOURCE_REVISION_ENV] = oldSha;
    if (oldRoot === undefined) delete process.env[SOURCE_ROOT_ENV];
    else process.env[SOURCE_ROOT_ENV] = oldRoot;
  }
});

test("a skipped acceptance file is not proven by another passing test", () => {
  const root = fixture();
  file(
    root,
    "tests/feature.test.ts",
    'import { test } from "bun:test";\ntest.skip("feature", () => {});\n',
  );
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  file(
    root,
    ".git/task.json",
    JSON.stringify({
      schemaVersion: TASK_PACKET_VERSION,
      goal: "Prove acceptance execution",
      baselineSha: baseline,
      ownedCapability: "example/feature",
      mustPreserve: [],
      outOfScope: [],
      changeKinds: ["behavior"],
      acceptance: { product: product(baseline) },
    }),
  );
  const result = agentVerificationCommand(root, ".git/task.json");
  expect(result.status).toBe("unavailable");
  expect(result.diagnostics.map((item) => item.code)).toContain(
    "verification-acceptance-test-unproven",
  );
});

test("a separately executed acceptance file provides current-head evidence", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  file(
    root,
    ".git/task.json",
    JSON.stringify({
      schemaVersion: TASK_PACKET_VERSION,
      goal: "Prove acceptance execution",
      baselineSha: baseline,
      ownedCapability: "example/feature",
      mustPreserve: [],
      outOfScope: [],
      changeKinds: ["behavior"],
      acceptance: { product: product(baseline) },
    }),
  );
  const result = agentVerificationCommand(root, ".git/task.json");
  expect(result.status).toBe("passed");
  expect(result.data.mergeVerification).toBeDefined();
});

test("does not verify or hand off product evidence bound to a different checkout", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  const packet: TaskPacket = {
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Keep approved behavior",
    baselineSha: baseline,
    ownedCapability: "example/feature",
    mustPreserve: [],
    outOfScope: [],
    changeKinds: ["behavior"],
    acceptance: { product: product(baseline) },
  };
  file(root, ".git/task.json", JSON.stringify(packet));
  const priorSha = process.env[SOURCE_REVISION_ENV];
  const priorRoot = process.env[SOURCE_ROOT_ENV];
  process.env[SOURCE_REVISION_ENV] = sha;
  process.env[SOURCE_ROOT_ENV] = root;
  try {
    const verification = agentVerificationCommand(root, ".git/task.json");
    expect(verification.status).toBe("unavailable");
    expect(verification.diagnostics[0]?.code).toBe("verification-source-revision-mismatch");
    const handoff = agentHandoffCommand(root, ".git/task.json", "not-created.json");
    expect(handoff.status).toBe("unavailable");
    expect(handoff.diagnostics[0]?.code).toBe("handoff-source-revision-mismatch");
  } finally {
    if (priorSha === undefined) delete process.env[SOURCE_REVISION_ENV];
    else process.env[SOURCE_REVISION_ENV] = priorSha;
    if (priorRoot === undefined) delete process.env[SOURCE_ROOT_ENV];
    else process.env[SOURCE_ROOT_ENV] = priorRoot;
  }
});

test("handoff never upgrades an independent-agent claim from a saved report", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  const packet: TaskPacket = {
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Keep approved behavior",
    baselineSha: baseline,
    ownedCapability: "example/feature",
    mustPreserve: [],
    outOfScope: [],
    changeKinds: ["behavior"],
    acceptance: { product: product(baseline) },
  };
  const normalized = normalizeTaskPacket(packet);
  file(root, ".git/task.json", JSON.stringify(packet));
  file(
    root,
    ".git/verification.json",
    JSON.stringify({
      schemaVersion: 1,
      operation: "agent-verification",
      status: "passed",
      durationMs: 0,
      data: {
        candidateSha: baseline,
        packetDigest: normalized.digest,
        independence: { claim: "forged-authority", status: "verified", machineVerified: true },
        mergeVerification: {
          ...selectMergeVerification(root, baseline, [], normalized.packet!.acceptance!.product!),
          execution: "full-capability-checks",
        },
      },
      diagnostics: [],
    }),
  );
  const handoff = agentHandoffCommand(root, ".git/task.json", ".git/verification.json");
  expect(handoff.status).toBe("passed");
  expect(handoff.data.independence).toEqual({
    claim: "reviewer-context",
    status: "claimed-unverified",
    machineVerified: false,
  });
});

test("handoff rejects a saved report whose merge verification was edited", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  const baseline = commit(root);
  const packet: TaskPacket = {
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Keep approved behavior",
    baselineSha: baseline,
    ownedCapability: "example/feature",
    mustPreserve: [],
    outOfScope: [],
    changeKinds: ["behavior"],
    acceptance: { product: product(baseline) },
  };
  const normalized = normalizeTaskPacket(packet);
  file(root, ".git/task.json", JSON.stringify(packet));
  const genuine = {
    ...selectMergeVerification(root, baseline, [], normalized.packet!.acceptance!.product!),
    execution: "full-capability-checks" as const,
  };
  for (const mergeVerification of [
    null,
    { ...genuine, mode: genuine.mode === "affected" ? "full-required" : "affected" },
    { ...genuine, sourceRevision: "0".repeat(40) },
    { ...genuine, coverageBasis: "closed-static-import-graph", selectedTests: ["forged.test.ts"] },
  ]) {
    file(
      root,
      ".git/verification.json",
      JSON.stringify({
        schemaVersion: 1,
        operation: "agent-verification",
        status: "passed",
        durationMs: 0,
        data: { candidateSha: baseline, packetDigest: normalized.digest, mergeVerification },
        diagnostics: [],
      }),
    );
    const handoff = agentHandoffCommand(root, ".git/task.json", ".git/verification.json");
    expect(handoff.status).toBe("unavailable");
    expect(handoff.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "handoff-merge-verification-mismatch",
    );
  }
});
