import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { analyzeExpectations } from "../src/expectations.ts";

const roots: string[] = [];
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-http-route-evidence-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "http-fixture", scripts: { "test:integration": "exit 99" } }),
  );
  writeFileSync(
    join(root, "openapi.json"),
    JSON.stringify({ openapi: "3.1.0", paths: { "/one": { get: {} }, "/two": { post: {} } } }),
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function httpFindings(root: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === "http-route-contract-evidence",
  );
}
describe("explicit HTTP route evidence findings", () => {
  test("stable advisory route findings survive unrelated source/test reachability", () => {
    const root = repository();
    const before = httpFindings(root);
    expect(before).toHaveLength(2);
    expect(
      before.every(
        ({ policyKind, severity }) => policyKind === "advisory" && severity === "warning",
      ),
    ).toBeTrue();
    writeFileSync(join(root, "import.test.ts"), 'import "./handler.ts";\n');
    writeFileSync(join(root, "handler.ts"), 'export const handler = () => "ok";\n');
    expect(httpFindings(root).map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    expect(before[0]?.evidence).toContainEqual(
      expect.objectContaining({ path: ".coding-tooling.contracts.json" }),
    );
  });
  test("only an explicit strong case mapping satisfies the declared relationship", () => {
    const root = repository();
    const mapping = {
      id: "one-availability",
      surface: "http-operation:GET:%2Fone",
      kind: "behavioral",
      capability: "test:integration",
    };
    writeFileSync(
      join(root, ".coding-tooling.contracts.json"),
      JSON.stringify({ schemaVersion: 1, verifications: [mapping] }),
    );
    expect(httpFindings(root)).toHaveLength(2);
    writeFileSync(
      join(root, ".coding-tooling.contracts.json"),
      JSON.stringify({
        schemaVersion: 1,
        verifications: [{ ...mapping, case: { id: "one-case", behavior: "availability" } }],
      }),
    );
    const remaining = httpFindings(root);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.requirement.key).toBe("http-operation:POST:%2Ftwo");
    writeFileSync(
      join(root, ".coding-tooling.contracts.json"),
      JSON.stringify({
        schemaVersion: 1,
        verifications: [
          { ...mapping, kind: "reachability", case: { id: "one-case", behavior: "availability" } },
        ],
      }),
    );
    expect(httpFindings(root)).toHaveLength(2);
  });
});
