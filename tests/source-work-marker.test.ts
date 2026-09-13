import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDetectorContext } from "../src/expectation-detectors.ts";
import {
  sourceDebtMarkerFindings,
  sourceWorkMarkerFindings,
} from "../src/expectation-gap-detectors.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-work-marker-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  return root;
}

test("exposes each structured work marker as an exact source location", () => {
  const root = fixture();
  writeFileSync(
    join(root, "src", "endpoint.ts"),
    [
      "export function endpoint() {",
      "  // TODO: [coding-tooling:endpoint-query] Load the entity through the repository abstraction.",
      "  return undefined;",
      "}",
      "// TODO: [coding-tooling:endpoint-result] Map the domain result to the public response contract.",
      "",
    ].join("\n"),
  );

  const findings = sourceWorkMarkerFindings(createDetectorContext(root));

  expect(findings).toHaveLength(2);
  expect(findings.map((finding) => finding.subject.key)).toEqual([
    "src/endpoint.ts#coding-tooling:endpoint-query",
    "src/endpoint.ts#coding-tooling:endpoint-result",
  ]);
  expect(findings[0]).toMatchObject({
    subject: {
      path: "src/endpoint.ts",
      description: "Work marker endpoint-query in src/endpoint.ts:2",
    },
    requirement: {
      key: "resolve-work-marker:endpoint-query",
      description: "Load the entity through the repository abstraction.",
    },
    message: "Load the entity through the repository abstraction.",
    relatedFiles: ["src/endpoint.ts"],
  });
  expect(findings[0]?.evidence[0]?.detail).toContain("on line 2");
});

test("scans test source so generated test placeholders remain visible to agents", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests", "endpoint.test.ts"),
    [
      'import { test } from "bun:test";',
      "",
      "// TODO: [coding-tooling:test-endpoint] Assert the public endpoint response and failure mapping.",
      'test.todo("endpoint contract");',
      "",
    ].join("\n"),
  );

  const findings = sourceWorkMarkerFindings(createDetectorContext(root));

  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    subject: {
      key: "tests/endpoint.test.ts#coding-tooling:test-endpoint",
      path: "tests/endpoint.test.ts",
      description: "Work marker test-endpoint in tests/endpoint.test.ts:3",
    },
    message: "Assert the public endpoint response and failure mapping.",
  });
});

test("does not double-count structured markers as generic TODO debt", () => {
  const root = fixture();
  writeFileSync(
    join(root, "src", "service.ts"),
    [
      "// TODO: [coding-tooling:service-behavior] Implement the declared behavior.",
      "// TODO: remove the compatibility fallback",
      "export const value = true;",
      "",
    ].join("\n"),
  );

  const context = createDetectorContext(root);
  const structured = sourceWorkMarkerFindings(context);
  const generic = sourceDebtMarkerFindings(context);

  expect(structured).toHaveLength(1);
  expect(generic).toHaveLength(1);
  expect(generic[0]?.message).toContain("1 TODO/FIXME debt marker");
});

test("ignores marker-like text that is not in the bounded comment syntax", () => {
  const root = fixture();
  writeFileSync(
    join(root, "src", "strings.ts"),
    'export const value = "TODO: [coding-tooling:not-work] This is display text.";\n',
  );

  expect(sourceWorkMarkerFindings(createDetectorContext(root))).toEqual([]);
});
