import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { buildAgentCapabilityCatalog } from "../src/agent-capabilities.ts";

function repository(metadata: string): string {
  const root = mkdtempSync(join(tmpdir(), "agent-procedure-metadata-"));
  const skill = join(root, "skills", "sample");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    `---\nid: "general/sample"\nname: "sample"\ndescription: "Sample capability."\nkind: "skill"\nmaturity: "stable"\nentry-point: true\nintents: ["sample"]\nrequires: []\nrelated-to: []\nreadiness: []\nextensions:\n  agent.procedure:\n${metadata}\n---\n\n# Sample\n`,
  );
  return root;
}

const validMetadata = `    schemaVersion: 1\n    routing:\n      useWhen: ["The task needs this procedure."]\n      doNotUseWhen: ["A more specific procedure applies."]\n      mutates: false\n      approvalBoundary: "none"\n    termination:\n      terminal: true\n      doneWhen: ["The requested assessment is complete."]\n      stopWithoutChangeWhen: ["No material finding is supported."]\n      escalateWhen: ["Intent is unresolved."]\n      evidenceRequired: ["Relevant repository evidence was inspected."]\n      outOfScope: ["Applying unrelated changes."]\n    artifacts:\n      consumes: ["repository-state"]\n      produces: ["sample-result"]`;

test("validates and preserves agent.procedure metadata", () => {
  const catalog = buildAgentCapabilityCatalog(repository(validMetadata), "test-revision");
  expect(catalog.capabilities[0]?.extensions["agent.procedure"]).toEqual({
    schemaVersion: 1,
    routing: {
      useWhen: ["The task needs this procedure."],
      doNotUseWhen: ["A more specific procedure applies."],
      mutates: false,
      approvalBoundary: "none",
    },
    termination: {
      terminal: true,
      doneWhen: ["The requested assessment is complete."],
      stopWithoutChangeWhen: ["No material finding is supported."],
      escalateWhen: ["Intent is unresolved."],
      evidenceRequired: ["Relevant repository evidence was inspected."],
      outOfScope: ["Applying unrelated changes."],
    },
    artifacts: {
      consumes: ["repository-state"],
      produces: ["sample-result"],
    },
  });
});

test("requires the v1 procedure metadata discriminator", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository(validMetadata.replace("    schemaVersion: 1\n", "    schemaVersion: 2\n")),
      "test-revision",
    ),
  ).toThrow("schemaVersion must be 1");
});

test("rejects an unknown approval boundary", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository(
        validMetadata.replace('approvalBoundary: "none"', 'approvalBoundary: "sometimes"'),
      ),
      "test-revision",
    ),
  ).toThrow("approvalBoundary must be none, conditional, or required");
});

test("requires evidence for procedure completion", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository(
        validMetadata.replace(
          'evidenceRequired: ["Relevant repository evidence was inspected."]',
          "evidenceRequired: []",
        ),
      ),
      "test-revision",
    ),
  ).toThrow("evidenceRequired must contain at least one item");
});

test("rejects malformed artifact identities", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository(
        validMetadata.replace('produces: ["sample-result"]', 'produces: ["Not Valid"]'),
      ),
      "test-revision",
    ),
  ).toThrow("artifacts.produces contains invalid artifact ID Not Valid");
});
