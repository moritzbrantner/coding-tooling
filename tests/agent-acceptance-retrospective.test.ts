// Retrospective acceptance for issue #303 (independent acceptance context).
// These scenarios were derived from issue #303 and dotfiles PR #25 against the
// pre-implementation baseline 0beeb6d1d6902f091e1f5169433c4ed42c901167. They
// were added after the implementation existed; they are not pre-implementation
// authorship. They exercise only the public agent task-packet / verify /
// handoff commands.
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  agentHandoffCommand,
  agentVerificationCommand,
  normalizeTaskPacket,
  TASK_PACKET_VERSION,
} from "../src/agent-work.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function repository(): { root: string; baseline: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-retro-acceptance-"));
  roots.push(root);
  file(
    root,
    "package.json",
    JSON.stringify({
      name: "retro",
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
    'import { expect, test } from "bun:test";\nimport { feature } from "../src/feature.ts";\ntest("feature", () => { expect(feature).toBeGreaterThan(0); });\n',
  );
  file(
    root,
    "tests/other.test.ts",
    'import { expect, test } from "bun:test";\nimport { other } from "../src/other.ts";\ntest("other", () => { expect(other).toBe(2); });\n',
  );
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  return { root, baseline: commit(root) };
}

function writePacket(root: string, baseline: string, revision: string): void {
  file(
    root,
    ".git/task.json",
    JSON.stringify({
      schemaVersion: TASK_PACKET_VERSION,
      goal: "Change feature within the approved contract",
      baselineSha: baseline,
      ownedCapability: "example/feature",
      mustPreserve: [],
      outOfScope: [],
      changeKinds: ["behavior"],
      acceptance: {
        product: {
          specifications: [{ path: "docs/approved.md", revision }],
          contracts: [{ path: "tests/feature.test.ts", revision, capability: "test" }],
          coreSmokeCapabilities: ["test"],
          independentAgentClaim: "acceptance-context",
        },
      },
    }),
  );
}

test("retrospective acceptance: legacy v1 packet digest is unchanged from the baseline", () => {
  // Digest computed on baseline 0beeb6d for the documented docs/agent-work.md example.
  const result = normalizeTaskPacket({
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Make checkpoint recovery reject missing intermediate mesh deltas",
    baselineSha: "0123456789abcdef0123456789abcdef01234567",
    ownedCapability: "streaming/checkpoint-recovery",
    mustPreserve: ["exact geometry fingerprints", "checkpoint byte stability"],
    outOfScope: ["transport protocol redesign"],
    changeKinds: ["behavior", "protocol"],
    acceptance: {
      requiredCapabilities: ["test:integration"],
      reviewRequirements: ["missing intermediate delta is rejected"],
    },
    integrationCondition: "all exact-head required evidence passes",
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.digest).toBe("9c4e57cc2ea24d5d2ecd5df38123192cce54b8b016a88ca32d0bb1ba041467bc");
});

test("retrospective acceptance: covered change verifies as affected and handoff keeps the claim unverified", () => {
  const { root, baseline } = repository();
  file(root, "src/feature.ts", "export const feature = 3;\n");
  const candidate = commit(root);
  writePacket(root, baseline, baseline);

  const verification = agentVerificationCommand(root, ".git/task.json");
  expect(verification.status).toBe("passed");
  expect(verification.data.mergeVerification).toMatchObject({
    mode: "affected",
    sourceRevision: candidate,
    coreSmokeCapabilities: ["test"],
    execution: "full-capability-checks",
  });
  const selected = (verification.data.mergeVerification as { selectedTests: string[] })
    .selectedTests;
  expect(selected).toContain("tests/feature.test.ts");
  expect(selected).not.toContain("tests/other.test.ts");
  expect(verification.data.independence).toMatchObject({
    status: "claimed-unverified",
    machineVerified: false,
  });

  file(root, ".git/verification.json", JSON.stringify(verification));
  const handoff = agentHandoffCommand(root, ".git/task.json", ".git/verification.json");
  expect(handoff.status).toBe("passed");
  expect(handoff.data.mergeVerification).toMatchObject({ mode: "affected" });
  expect(handoff.data.independence).toMatchObject({
    status: "claimed-unverified",
    machineVerified: false,
  });
});

test("retrospective acceptance: untested or shared changes fall back to full-required", () => {
  for (const [path, content] of [
    ["src/unlinked.ts", "export const unlinked = 1;\n"],
    [
      "package.json",
      JSON.stringify({
        name: "retro",
        version: "1.0.1",
        type: "module",
        scripts: { test: "bun test" },
      }),
    ],
  ] as const) {
    const { root, baseline } = repository();
    file(root, path, content);
    commit(root);
    writePacket(root, baseline, baseline);
    const verification = agentVerificationCommand(root, ".git/task.json");
    expect(verification.status).toBe("passed");
    const decision = verification.data.mergeVerification as { mode: string; reason: string };
    expect(decision.mode).toBe("full-required");
    expect(decision.reason).toBeString();
    expect(decision.reason.length).toBeGreaterThan(0);
  }
});

test("retrospective acceptance: an approved specification changed after its pinned revision is not passed", () => {
  const { root, baseline } = repository();
  file(root, "docs/approved.md", "Silently rewritten approved behavior\n");
  commit(root);
  writePacket(root, baseline, baseline);
  const verification = agentVerificationCommand(root, ".git/task.json");
  expect(verification.status).toBe("unavailable");
  file(root, ".git/verification.json", JSON.stringify(verification));
  expect(agentHandoffCommand(root, ".git/task.json", ".git/verification.json").status).not.toBe(
    "passed",
  );
});

test("retrospective acceptance: a failing acceptance contract fails verification", () => {
  const { root, baseline } = repository();
  file(root, "src/feature.ts", "export const feature = -1;\n");
  commit(root);
  writePacket(root, baseline, baseline);
  const verification = agentVerificationCommand(root, ".git/task.json");
  expect(verification.status).toBe("failed");
});
