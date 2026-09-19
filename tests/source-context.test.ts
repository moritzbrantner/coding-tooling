import { afterEach, expect, test } from "bun:test";

import { sourceRevision } from "../src/source-context.ts";
import type { CommandResult } from "../src/shared.ts";

const originalSha = process.env.CODING_TOOLING_SOURCE_SHA;
const originalRoot = process.env.CODING_TOOLING_SOURCE_ROOT;

afterEach(() => {
  if (originalSha === undefined) delete process.env.CODING_TOOLING_SOURCE_SHA;
  else process.env.CODING_TOOLING_SOURCE_SHA = originalSha;
  if (originalRoot === undefined) delete process.env.CODING_TOOLING_SOURCE_ROOT;
  else process.env.CODING_TOOLING_SOURCE_ROOT = originalRoot;
});

function result(stdout: string, status = 0): CommandResult {
  return {
    command: ["git", "rev-parse", "HEAD"],
    status,
    stdout,
    stderr: "",
  };
}

test("prefers caller-pushed source revision without querying Git", () => {
  const pushed = "a".repeat(40);
  process.env.CODING_TOOLING_SOURCE_SHA = pushed;
  process.env.CODING_TOOLING_SOURCE_ROOT = process.cwd();

  expect(
    sourceRevision(".", () => {
      throw new Error("Git must not be queried when the caller pushed source context");
    }),
  ).toBe(pushed);
});

test("fails closed on malformed pushed source revision", () => {
  process.env.CODING_TOOLING_SOURCE_SHA = "not-a-sha";
  process.env.CODING_TOOLING_SOURCE_ROOT = process.cwd();

  expect(
    sourceRevision(".", () => {
      throw new Error("Malformed pushed context must not silently fall back to Git");
    }),
  ).toBeUndefined();
});

test("falls back to the requested repository when pushed context belongs elsewhere", () => {
  process.env.CODING_TOOLING_SOURCE_SHA = "a".repeat(40);
  process.env.CODING_TOOLING_SOURCE_ROOT = process.cwd();
  const fixtureHead = "c".repeat(40);

  expect(sourceRevision("/tmp/other-repository", () => result(`${fixtureHead}\n`))).toBe(
    fixtureHead,
  );
});

test("uses local Git HEAD only when no source revision was pushed", () => {
  delete process.env.CODING_TOOLING_SOURCE_SHA;
  const head = "b".repeat(40);

  expect(sourceRevision(".", () => result(`${head}\n`))).toBe(head);
});
