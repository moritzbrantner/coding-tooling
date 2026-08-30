import { expect, test } from "bun:test";

import { integratePullRequest, summarizeChecks } from "../src/pr.ts";
import { type ResultEnvelope } from "../src/model.ts";
import { type CommandResult } from "../src/shared.ts";

const headSha = "1111111111111111111111111111111111111111";
const baseSha = "2222222222222222222222222222222222222222";
const movedBaseSha = "3333333333333333333333333333333333333333";
const originalSha = "4444444444444444444444444444444444444444";

function result(stdout = "", status = 0, stderr = ""): CommandResult {
  return { command: [], status, stdout, stderr };
}

function prJson(remoteCheck: "success" | "failed" | "pending" = "success") {
  const statusCheckRollup =
    remoteCheck === "pending"
      ? [
          {
            __typename: "CheckRun",
            name: "test",
            status: "IN_PROGRESS",
            conclusion: "",
          },
        ]
      : [
          {
            __typename: "CheckRun",
            name: "test",
            status: "COMPLETED",
            conclusion: remoteCheck === "failed" ? "FAILURE" : "SUCCESS",
          },
        ];
  return JSON.stringify({
    number: 42,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: remoteCheck === "success" ? "CLEAN" : "UNSTABLE",
    reviewDecision: "APPROVED",
    headRefOid: headSha,
    baseRefName: "main",
    statusCheckRollup,
    url: "https://github.com/example/repo/pull/42",
  });
}

function pipeline(status: ResultEnvelope<Record<string, unknown>>["status"] = "passed") {
  return (): ResultEnvelope<Record<string, unknown>> => ({
    schemaVersion: 1,
    operation: "run",
    status,
    durationMs: 1,
    data: { tier: "full" },
    diagnostics: [],
  });
}

function fakeRunner(
  options: { moveBase?: boolean; remoteCheck?: "success" | "failed" | "pending" } = {},
) {
  let baseReads = 0;
  let mergeCalls = 0;

  const run = (command: string, args: string[] = []): CommandResult => {
    if ((command === "git" || command === "gh") && args[0] === "--version") return result("ok\n");
    if (command === "git" && args.join(" ") === "status --porcelain") return result();
    if (command === "git" && args.join(" ") === "status --porcelain --untracked-files=no")
      return result();
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return result(`${originalSha}\n`);
    if (command === "git" && args.join(" ") === "symbolic-ref --quiet --short HEAD")
      return result("main\n");
    if (command === "gh" && args[0] === "pr" && args[1] === "view")
      return result(prJson(options.remoteCheck));
    if (command === "git" && args[0] === "fetch") return result();
    if (command === "git" && args.join(" ") === "rev-parse refs/remotes/origin/main") {
      baseReads += 1;
      return result(`${options.moveBase && baseReads > 1 ? movedBaseSha : baseSha}\n`);
    }
    if (command === "git" && args.join(" ") === "rev-parse refs/coding-tooling/pr/42")
      return result(`${headSha}\n`);
    if (command === "git" && args[0] === "checkout") return result();
    if (command === "git" && args.includes("merge")) return result();
    if (command === "git" && args.join(" ") === "reset --hard HEAD") return result();
    if (command === "git" && args[0] === "update-ref") return result();
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
      mergeCalls += 1;
      return result();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  return { run, mergeCalls: () => mergeCalls };
}

test("summarizes successful, pending, and failed checks", () => {
  expect(
    summarizeChecks([
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "lint", state: "FAILURE" },
    ]),
  ).toEqual({
    total: 3,
    passed: ["build"],
    pending: ["test"],
    failed: ["lint"],
  });
});

test("merges only after the synthetic merge and local pipeline pass", () => {
  const fake = fakeRunner();
  const integration = integratePullRequest(
    "/repo",
    42,
    {},
    { run: fake.run, runPipeline: pipeline("passed") },
  );

  expect(integration.status).toBe("passed");
  expect(integration.data.merged).toBe(true);
  expect(fake.mergeCalls()).toBe(1);
});

test("remote checks are advisory by default", () => {
  const fake = fakeRunner({ remoteCheck: "failed" });
  const integration = integratePullRequest(
    "/repo",
    42,
    {},
    { run: fake.run, runPipeline: pipeline("passed") },
  );

  expect(integration.status).toBe("passed");
  expect(integration.data.merged).toBe(true);
  expect(integration.data.remoteChecksPolicy).toBe("advisory");
  expect(integration.data.remoteChecks).toEqual({
    total: 1,
    passed: [],
    pending: [],
    failed: ["test"],
  });
  expect(fake.mergeCalls()).toBe(1);
});

test("remote checks can still be required explicitly", () => {
  const fake = fakeRunner({ remoteCheck: "failed" });
  const integration = integratePullRequest(
    "/repo",
    42,
    { remoteChecks: "required" },
    { run: fake.run, runPipeline: pipeline("passed") },
  );

  expect(integration.status).toBe("unavailable");
  expect(
    integration.diagnostics.some((diagnostic) => diagnostic.code === "remote-checks-failed"),
  ).toBe(true);
  expect(fake.mergeCalls()).toBe(0);
});

test("advisory remote checks also ignore pending hosted checks", () => {
  const fake = fakeRunner({ remoteCheck: "pending" });
  const integration = integratePullRequest(
    "/repo",
    42,
    {},
    { run: fake.run, runPipeline: pipeline("passed") },
  );

  expect(integration.status).toBe("passed");
  expect(fake.mergeCalls()).toBe(1);
});

test("does not merge when the base moves after local verification", () => {
  const fake = fakeRunner({ moveBase: true, remoteCheck: "failed" });
  const integration = integratePullRequest(
    "/repo",
    42,
    {},
    { run: fake.run, runPipeline: pipeline("passed") },
  );

  expect(integration.status).toBe("unavailable");
  expect(integration.diagnostics.some((diagnostic) => diagnostic.code === "base-moved")).toBe(true);
  expect(fake.mergeCalls()).toBe(0);
});
