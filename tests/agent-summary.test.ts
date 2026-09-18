import { expect, test } from "bun:test";

import { collapseAgentEvidence } from "../src/agent-summary.ts";
import type { ExpectationRegistryRecord } from "../src/expectation-detectors.ts";
import type { Finding, FindingSeverity } from "../src/expectation-model.ts";

function finding(
  id: string,
  expectationId: string,
  subjectKey: string,
  severity: FindingSeverity,
): Finding {
  return {
    id,
    expectationId,
    expectationVersion: 1,
    policyKind: "advisory",
    severity,
    state: "new",
    disposition: "active",
    subject: {
      kind: "file",
      key: subjectKey,
      path: subjectKey,
      description: subjectKey,
    },
    requirement: {
      kind: "check",
      key: `${expectationId}-requirement`,
      description: `${expectationId} requirement`,
    },
    message: `${expectationId} failed for ${subjectKey}`,
    evidence: [],
    relatedFiles: [subjectKey],
    verification: [],
    relationships: [],
  };
}

function registry(id: string, independenceKey: string, oracle: string): ExpectationRegistryRecord {
  return {
    id,
    version: 1,
    description: id,
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle,
      independenceKey,
      proves: `${id} fact`,
      limitations: [`${id} limitation`],
    },
  };
}

test("collapses correlated representations only for the same subject", () => {
  const groups = collapseAgentEvidence(
    [
      finding("CT-000000000001", "first", "src/a.ts", "warning"),
      finding("CT-000000000002", "second", "src/a.ts", "warning"),
      finding("CT-000000000003", "second", "src/b.ts", "warning"),
    ],
    [
      registry("first", "typescript-compiler", "tsc"),
      registry("second", "typescript-compiler", "tsc"),
    ],
  );

  expect(groups).toHaveLength(2);
  expect(groups[0]?.subject.key).toBe("src/a.ts");
  expect(groups[0]?.representationCount).toBe(2);
  expect(groups[0]?.findingIds).toEqual(["CT-000000000001", "CT-000000000002"]);
  expect(groups[0]?.evidence.oracles).toEqual(["tsc"]);
  expect(groups[1]?.subject.key).toBe("src/b.ts");
  expect(groups[1]?.representationCount).toBe(1);
});

test("orders the strongest actionable evidence first", () => {
  const groups = collapseAgentEvidence(
    [
      finding("CT-000000000004", "warning-check", "src/a.ts", "warning"),
      finding("CT-000000000005", "error-check", "src/z.ts", "error"),
    ],
    [
      registry("warning-check", "warning-family", "warning-oracle"),
      registry("error-check", "error-family", "error-oracle"),
    ],
  );

  expect(groups[0]?.highestSeverity).toBe("error");
  expect(groups[0]?.primaryFinding.id).toBe("CT-000000000005");
});
