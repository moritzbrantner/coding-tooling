import { expect, test } from "bun:test";

import { classifyPullRequestChecks } from "../src/pr-integration-receipt.ts";

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
