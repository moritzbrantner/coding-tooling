import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convergeRepository } from "../src/convergence.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("converges a mechanical missing-test gap into explicit agent implementation work", () => {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-converge-integration-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    '{"name":"fixture","scripts":{"test":"bun test"}}\n',
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

  const result = convergeRepository(root, { verifyTier: null });

  expect(result.status).toBe("passed");
  expect(result.data.result).toBe("partial");
  expect(result.data.rounds).toHaveLength(1);
  expect(existsSync(join(root, "tests", "service.test.ts"))).toBeTrue();
  expect(result.data.handoff).toContainEqual(
    expect.objectContaining({
      kind: "implementation",
      expectationIds: ["source-work-marker"],
      relatedFiles: ["tests/service.test.ts"],
      summary: expect.stringContaining("tests/service.test.ts:4"),
    }),
  );
});
