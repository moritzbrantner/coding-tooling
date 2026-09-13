import { expect, test } from "bun:test";

import {
  checksMatchEligibilityHead,
  classifyPullRequestChecks,
} from "../src/pr-integration-receipt.ts";

test("keeps skipped pull-request checks distinct from passed checks", () => {
  expect(
    classifyPullRequestChecks([
      { __typename: "CheckRun", name: "validate", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "pages", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "CheckRun", name: "runtime", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "lint", state: "FAILURE" },
    ]),
  ).toEqual([
    { name: "lint", state: "failed" },
    { name: "pages", state: "skipped" },
    { name: "runtime", state: "pending" },
    { name: "validate", state: "passed" },
  ]);
});

test("rejects check evidence fetched for a different pull-request head", () => {
  const first = "0123456789abcdef0123456789abcdef01234567";
  const second = "fedcba9876543210fedcba9876543210fedcba98";
  expect(checksMatchEligibilityHead(first, first)).toBe(true);
  expect(checksMatchEligibilityHead(first, second)).toBe(false);
  expect(checksMatchEligibilityHead(first, undefined)).toBe(false);
});
