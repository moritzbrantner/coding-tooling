import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { buildAgentCapabilityCatalog } from "../src/agent-capabilities.ts";

function contractsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-contracts-flow-"));
  mkdirSync(join(root, "schemas"), { recursive: true });
  writeFileSync(
    join(root, "CATALOG.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contracts: [
          {
            id: "agent.diagnosis-envelope/v1",
            schema: "schemas/diagnosis.json",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "schemas", "diagnosis.json"),
    `${JSON.stringify(
      {
        type: "object",
        properties: {
          confidence: { enum: ["confirmed", "probable", "unresolved"] },
          ambiguous: {
            oneOf: [{ type: "string" }, { const: "x" }],
          },
          payload: {
            oneOf: [{ $ref: "#/$defs/bugPayload" }, { $ref: "#/$defs/performancePayload" }],
          },
        },
        $defs: {
          bugPayload: {
            type: "object",
            properties: {
              affectedSurface: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
            },
          },
          performancePayload: {
            type: "object",
            properties: {
              actionable: { type: "boolean" },
              causeCategory: {
                enum: ["local-implementation", "architecture-data-movement", "unresolved"],
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function repositoryWithSteps(steps: string): string {
  const root = mkdtempSync(join(tmpdir(), "agent-flow-contract-"));
  const diagnose = join(root, "skills", "diagnosing-bugs");
  const fix = join(root, "flows", "fix-bug");
  mkdirSync(diagnose, { recursive: true });
  mkdirSync(fix, { recursive: true });
  writeFileSync(
    join(diagnose, "SKILL.md"),
    `---\nid: "general/diagnosing-bugs"\nname: "diagnosing-bugs"\ndescription: "Diagnose a bug."\nkind: "skill"\nmaturity: "stable"\nentry-point: true\nintents: ["bug"]\nrequires: []\nrelated-to: ["general/fix-bug"]\nreadiness: []\nextensions: {}\n---\n\n# Diagnose\n`,
  );
  writeFileSync(
    join(fix, "FLOW.md"),
    `---\nid: "general/fix-bug"\nname: "fix-bug"\ndescription: "Fix a bug."\nkind: "flow"\nmaturity: "stable"\nentry-point: true\nintents: ["bug", "fix"]\nrequires: []\nrelated-to: ["general/diagnosing-bugs"]\nreadiness: []\nflow:\n  steps:\n${steps}\nextensions: {}\n---\n\n# Fix\n`,
  );
  return root;
}

function repository(
  conditionSource: string,
  conditionValue: string,
  outputContract: string | undefined = "agent.diagnosis-envelope/v1",
  namedOutput = true,
): string {
  const outputLine = namedOutput ? '      output: "diagnosis"\n' : "";
  const outputContractLine = outputContract ? `      output-contract: "${outputContract}"\n` : "";
  return repositoryWithSteps(
    `    - id: diagnose\n      kind: invoke\n      capability: "general/diagnosing-bugs"\n${outputLine}${outputContractLine}    - id: condition\n      kind: branch\n      condition:\n        source: "${conditionSource}"\n        equals: "${conditionValue}"\n      then: []\n      else: []`,
  );
}

test("accepts a branch path and enum value declared by the output contract", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.confidence", "unresolved"),
      "test-revision",
      contractsRoot(),
    ),
  ).not.toThrow();
});

test("rejects a branch enum value not accepted by the output contract", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.confidence", "uncertain"),
      "test-revision",
      contractsRoot(),
    ),
  ).toThrow('value "uncertain" is not accepted');
});

test("rejects a scalar accepted by more than one oneOf alternative", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.ambiguous", "x"),
      "test-revision",
      contractsRoot(),
    ),
  ).toThrow('value "x" is not accepted');
});

test("rejects a branch field path absent from the output contract", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.affected-surface", "browser"),
      "test-revision",
      contractsRoot(),
    ),
  ).toThrow("source diagnosis.affected-surface is not present");
});

test("resolves nested paths through oneOf and local refs", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.payload.affectedSurface", "browser"),
      "test-revision",
      contractsRoot(),
    ),
  ).not.toThrow();
});

test("requires an explicit contracts root for contract-bound outputs", () => {
  expect(() =>
    buildAgentCapabilityCatalog(repository("diagnosis.confidence", "unresolved"), "test-revision"),
  ).toThrow("require an explicit agent-contracts root");
});

test("rejects a declared output contract absent from the local contract catalog", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.confidence", "unresolved", "agent.missing-diagnosis-envelope/v1"),
      "test-revision",
      contractsRoot(),
    ),
  ).toThrow("agent-contracts catalog does not contain agent.missing-diagnosis-envelope/v1");
});

test("requires a named output when an invoke step declares an output contract", () => {
  expect(() =>
    buildAgentCapabilityCatalog(
      repository("diagnosis.confidence", "unresolved", "agent.diagnosis-envelope/v1", false),
      "test-revision",
      contractsRoot(),
    ),
  ).toThrow("output-contract requires a named output");
});

test("rejects a contract-bound output referenced before its invoke step", () => {
  const root = repositoryWithSteps(
    `    - id: condition\n      kind: branch\n      condition:\n        source: "diagnosis.confidence"\n        equals: "unresolved"\n      then: []\n      else: []\n    - id: diagnose\n      kind: invoke\n      capability: "general/diagnosing-bugs"\n      output: "diagnosis"\n      output-contract: "agent.diagnosis-envelope/v1"`,
  );
  expect(() => buildAgentCapabilityCatalog(root, "test-revision", contractsRoot())).toThrow(
    "references contract-bound output diagnosis before it is available",
  );
});

test("rejects output produced in only one branch arm after the branch joins", () => {
  const root = repositoryWithSteps(
    `    - id: choose-diagnosis\n      kind: branch\n      condition:\n        source: "decision.run"\n        equals: "yes"\n      then:\n        - id: diagnose\n          kind: invoke\n          capability: "general/diagnosing-bugs"\n          output: "diagnosis"\n          output-contract: "agent.diagnosis-envelope/v1"\n      else: []\n    - id: consume-diagnosis\n      kind: branch\n      condition:\n        source: "diagnosis.confidence"\n        equals: "unresolved"\n      then: []\n      else: []`,
  );
  expect(() => buildAgentCapabilityCatalog(root, "test-revision", contractsRoot())).toThrow(
    "references contract-bound output diagnosis before it is available",
  );
});

test("accepts output produced with the same contract in both branch arms", () => {
  const root = repositoryWithSteps(
    `    - id: choose-diagnosis\n      kind: branch\n      condition:\n        source: "decision.kind"\n        equals: "primary"\n      then:\n        - id: primary-diagnosis\n          kind: invoke\n          capability: "general/diagnosing-bugs"\n          output: "diagnosis"\n          output-contract: "agent.diagnosis-envelope/v1"\n      else:\n        - id: alternate-diagnosis\n          kind: invoke\n          capability: "general/diagnosing-bugs"\n          output: "diagnosis"\n          output-contract: "agent.diagnosis-envelope/v1"\n    - id: consume-diagnosis\n      kind: branch\n      condition:\n        source: "diagnosis.confidence"\n        equals: "unresolved"\n      then: []\n      else: []`,
  );
  expect(() => buildAgentCapabilityCatalog(root, "test-revision", contractsRoot())).not.toThrow();
});

test("parallel siblings cannot consume outputs produced only by another sibling", () => {
  const root = repositoryWithSteps(
    `    - id: parallel-work\n      kind: parallel\n      steps:\n        - id: diagnose\n          kind: invoke\n          capability: "general/diagnosing-bugs"\n          output: "diagnosis"\n          output-contract: "agent.diagnosis-envelope/v1"\n        - id: inspect-diagnosis\n          kind: branch\n          condition:\n            source: "diagnosis.confidence"\n            equals: "unresolved"\n          then: []\n          else: []`,
  );
  expect(() => buildAgentCapabilityCatalog(root, "test-revision", contractsRoot())).toThrow(
    "references contract-bound output diagnosis before it is available",
  );
});

test("parallel output is available after the parallel join", () => {
  const root = repositoryWithSteps(
    `    - id: parallel-work\n      kind: parallel\n      steps:\n        - id: diagnose\n          kind: invoke\n          capability: "general/diagnosing-bugs"\n          output: "diagnosis"\n          output-contract: "agent.diagnosis-envelope/v1"\n        - id: unrelated\n          kind: human-gate\n          prompt: "Inspect unrelated evidence."\n    - id: consume-diagnosis\n      kind: branch\n      condition:\n        source: "diagnosis.confidence"\n        equals: "unresolved"\n      then: []\n      else: []`,
  );
  expect(() => buildAgentCapabilityCatalog(root, "test-revision", contractsRoot())).not.toThrow();
});
