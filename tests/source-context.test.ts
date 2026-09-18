import { afterEach, expect, test } from "bun:test";

import { sourceRevision } from "../src/source-context.ts";
import type { CommandResult } from "../src/shared.ts";

const original = process.env.CODING_TOOLING_SOURCE_SHA;

afterEach(() => {
  if (original === undefined) delete process.env.CODING_TOOLING_SOURCE_SHA;
  else process.env.CODING_TOOLING_SOURCE_SHA = original;
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

  expect(
    sourceRevision(".", () => {
      throw new Error("Git must not be queried when the caller pushed source context");
    }),
  ).toBe(pushed);
});

test("fails closed on malformed pushed source revision", () => {
  process.env.CODING_TOOLING_SOURCE_SHA = "not-a-sha";

  expect(
    sourceRevision(".", () => {
      throw new Error("Malformed pushed context must not silently fall back to Git");
    }),
  ).toBeUndefined();
});

test("uses local Git HEAD only when no source revision was pushed", () => {
  delete process.env.CODING_TOOLING_SOURCE_SHA;
  const head = "b".repeat(40);

  expect(sourceRevision(".", () => result(`${head}\n`))).toBe(head);
});
