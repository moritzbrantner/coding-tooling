import { expect, test } from "bun:test";

import {
  evidenceForChangeKinds,
  normalizeTaskPacket,
  TASK_PACKET_VERSION,
} from "../src/agent-work.ts";

const baselineSha = "0123456789abcdef0123456789abcdef01234567";

test("change kinds deterministically derive validation evidence", () => {
  expect(evidenceForChangeKinds(["browser", "performance", "replay"])).toEqual({
    requiredCapabilities: ["benchmark:smoke", "test", "test:e2e:smoke"],
    requiredEvidence: [
      "deterministic-replay",
      "equivalent-workload-benchmark",
      "representative-browser-journey",
      "versioned-or-declared-baseline",
    ],
  });
});

test("explicit acceptance requirements compose with derived requirements", () => {
  expect(
    evidenceForChangeKinds(["behavior"], ["typecheck", "test"], ["authority-boundary"]),
  ).toEqual({
    requiredCapabilities: ["test", "typecheck"],
    requiredEvidence: ["authority-boundary", "behavior-regression"],
  });
});

test("normalizes a bounded task packet to a stable digest", () => {
  const first = normalizeTaskPacket({
    schemaVersion: TASK_PACKET_VERSION,
    goal: "  Preserve exact replay  ",
    baselineSha: baselineSha.toUpperCase(),
    ownedCapability: " simulation/replay ",
    mustPreserve: ["ordering", "fingerprints", "ordering"],
    outOfScope: ["renderer"],
    changeKinds: ["replay", "behavior"],
    acceptance: {
      requiredCapabilities: ["typecheck", "test"],
      evidence: ["seeded replay"],
    },
  });
  const second = normalizeTaskPacket({
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Preserve exact replay",
    baselineSha,
    ownedCapability: "simulation/replay",
    mustPreserve: ["fingerprints", "ordering"],
    outOfScope: ["renderer"],
    changeKinds: ["behavior", "replay"],
    acceptance: {
      requiredCapabilities: ["test", "typecheck"],
      evidence: ["seeded replay"],
    },
  });

  expect(first.diagnostics).toEqual([]);
  expect(first.packet).toEqual(second.packet);
  expect(first.digest).toBe(second.digest);
  expect(first.packet?.baselineSha).toBe(baselineSha);
});

test("rejects inferred baselines and unknown change kinds", () => {
  const result = normalizeTaskPacket({
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Change behavior",
    baselineSha: "HEAD",
    ownedCapability: "example",
    mustPreserve: [],
    outOfScope: [],
    changeKinds: ["magic"],
  });
  expect(result.packet).toBeUndefined();
  expect(result.diagnostics.map((entry) => entry.code)).toEqual(
    expect.arrayContaining(["task-packet-baseline-invalid", "task-packet-change-kinds-invalid"]),
  );
});
