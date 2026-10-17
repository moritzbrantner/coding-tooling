// Acceptance for the read-only `coding-tooling fleet renovate` report (moritzbrantner/coding-tooling#330).
//
// Written independently, before the implementation. Owner decisions (issue #330, 2026-10-17):
// read-only report that never merges or bumps anything; majors keep Dependency Dashboard
// approval and pending ones are shown; missing config => add a minimal renovate.json that extends
// `github>moritzbrantner/coding-agent-conventions` through a normal PR; a missing Renovate app is an
// owner action; the four named repositories come first; mmorpg is excluded.
//
// PINNED SEAM
// - Module `src/fleet-renovate.ts` exports
//     fleetRenovateReport(root: string, options?: {
//       repositories?: string[];   // `--repo owner/name`, repeatable; replaces fleet enumeration
//       run?: Runner;              // same signature as open-pr-reconciliation.ts; default runCommand
//       now?: Date;                // clock for PR ages; default new Date()
//     }): ResultEnvelope
// - CLI: `coding-tooling fleet renovate [--root <path>] [--repo owner/name ...] [--json]` in
//   src/router.ts. Exit 0 for `passed`, 2 for `unavailable`. It is never `failed` because of
//   pending updates, failing bot PRs or missing config: the report is informational.
// - Envelope: schemaVersion 1, operation "fleet-renovate",
//   data.schemaVersion "coding-tooling/fleet-renovate/v1", data.repositories sorted by
//   `repository`, data.excluded (sorted ids left out by default).
// - Fleet enumeration with no `--repo`: the existing fleet seam, i.e. the direct child Git
//   repositories of `--root` as listed by fleetAuthorityGraph. The id is `.repository.toml` `id`;
//   when there is none, it is the `owner/name` of `git config --get remote.origin.url`. Ids are
//   deduplicated (worktree checkouts share their origin). `moritzbrantner/mmorpg` is excluded
//   by an explicit default exclusion and listed in data.excluded; it is never queried.
// - GitHub is read only through the injected runner calling `gh` (and, in the CLI, the `gh`
//   on PATH). Supported read calls, answered by tests/fixtures/fleet-renovate/mock-github.ts:
//     gh api repos/<repo>/contents/<path>     (base64 JSON; or raw with Accept vnd.github.raw)
//                                              exit 1 + "HTTP 404" means the file is absent
//     gh api repos/<repo>/branches[?...]       or  gh api repos/<repo>/git/matching-refs/heads/renovate
//     gh issue list|view --repo <repo> --json ...   (real gh quirk: issue `--author app/renovate`
//                                              matches nothing; use `renovate[bot]`, --search or
//                                              filter by title "Dependency Dashboard" in process)
//     gh pr list|view --repo <repo> --json ...      (`--author app/renovate` works for PRs)
//     gh repo view <repo> --json ...
//   No `--jq`/`--template`. Any non-404 failure of any of these reads makes the whole report
//   `unavailable` with a diagnostic naming the repository.
// - Per repository entry:
//     repository: "owner/name"
//     config: { present, path, extendsCentralPreset }  probing at least renovate.json,
//             .github/renovate.json, renovate.json5, .renovaterc, .renovaterc.json; path is null
//             when absent; extendsCentralPreset is true when `extends` holds an entry starting
//             with "github>moritzbrantner/coding-agent-conventions".
//     app: "installed" (open Dependency Dashboard issue, open Renovate PR, or a `renovate/*` branch)
//        | "unknown" (config present, no Renovate activity: an owner check)
//        | "needs-config" (no config and no activity)
//     dashboard: { issue: number | null,
//                  awaitingSchedule, pendingApproval, pendingStatusChecks: { branch, title }[]
//                  (in dashboard order, without the "create/approve all" aggregate lines),
//                  openPrs: { number, title, ageDays, checks }[] sorted by number }
//       ageDays = floor((now - createdAt) / 1 day); checks: "passing" | "failing" | "pending" | "none"
//       from statusCheckRollup (CheckRun conclusion FAILURE/TIMED_OUT/CANCELLED/ACTION_REQUIRED/
//       STARTUP_FAILURE or StatusContext FAILURE/ERROR => failing; otherwise a non-COMPLETED
//       CheckRun or PENDING/EXPECTED StatusContext => pending; SUCCESS/SKIPPED/NEUTRAL => passing).
//       Unknown dashboard sections are ignored, never errors.
//     actions: { kind, owner, message, pullRequest? }[] with kind one of
//       "add-config" (owner false, normal PR; message names renovate.json and the preset),
//       "extend-central-preset", "owner-install-app" (owner true),
//       "approve-majors-in-dashboard", "fix-failing-renovate-pr" (pullRequest),
//       "stale-pr" (pullRequest; ageDays > 14). Awaiting-schedule items alone are not an action.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  mockGithub,
  isReadOnlyCall,
  RENOVATE_BOT,
  type CommandResult,
  type MockPullRequest,
  type MockState,
} from "./fixtures/fleet-renovate/mock-github.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;
type Envelope = {
  schemaVersion: number;
  operation: string;
  status: string;
  durationMs: number;
  data: Record<string, unknown>;
  diagnostics: Array<Record<string, unknown>>;
};
type Report = (
  root: string,
  options?: { repositories?: string[]; run?: Runner; now?: Date },
) => Envelope;
type Item = { branch: string; title: string };
type Pr = { number: number; title: string; ageDays: number; checks: string };
type Action = { kind: string; owner: boolean; message: string; pullRequest?: number };
type Entry = {
  repository: string;
  config: { present: boolean; path: string | null; extendsCentralPreset: boolean };
  app: string;
  dashboard: {
    issue: number | null;
    awaitingSchedule: Item[];
    pendingApproval: Item[];
    pendingStatusChecks: Item[];
    openPrs: Pr[];
  };
  actions: Action[];
};

const repoRoot = resolve(import.meta.dir, "..");
const fixtures = join(import.meta.dir, "fixtures", "fleet-renovate");
const PRESET = "github>moritzbrantner/coding-agent-conventions";
const NOW = new Date("2026-10-17T12:00:00Z");

async function loadReport(): Promise<Report> {
  // Dynamic so each test fails on its own while the module does not exist yet.
  const modulePath = "../src/fleet-renovate.ts";
  const module = (await import(modulePath)) as { fleetRenovateReport: Report };
  return module.fleetRenovateReport;
}

const scrabbleDashboard = JSON.parse(
  readFileSync(join(fixtures, "scrabble-dashboard-36.json"), "utf8"),
) as { number: number; title: string; body: string };
const realPr = JSON.parse(
  readFileSync(join(fixtures, "physics-engine-renovate-pr-281.json"), "utf8"),
) as { pullRequest: MockPullRequest; statusContext: Record<string, unknown> };

const config = (extendsList: string[]) =>
  `${JSON.stringify(
    { $schema: "https://docs.renovatebot.com/renovate-schema.json", extends: extendsList },
    null,
    2,
  )}\n`;

// A healthy dashboard in the real format: nothing pending, only detected dependencies.
const healthyDashboard = [
  "This issue lists Renovate updates and detected dependencies. Read the [Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) docs to learn more.",
  "",
  "## Detected Dependencies",
  "",
  "<details><summary>cargo (1)</summary>",
  "<blockquote>",
  "",
  " - `serde 1.0.229`",
  "",
  "</blockquote>",
  "</details>",
  "",
  "---",
  "",
  "- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository",
].join("\n");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pr(number: number, createdAt: string, rollup: unknown[], branch: string): MockPullRequest {
  return {
    ...clone(realPr.pullRequest),
    number,
    createdAt,
    headRefName: branch,
    title: `chore(deps): update ${branch.replace("renovate/", "")}`,
    statusCheckRollup: rollup,
    author: RENOVATE_BOT,
  };
}

const realRollup = () => clone(realPr.pullRequest.statusCheckRollup) as Record<string, unknown>[];
const failingRollup = () => {
  const rollup = realRollup();
  rollup[1] = { ...rollup[1], conclusion: "FAILURE" };
  return rollup;
};
const pendingRollup = () => {
  const rollup = realRollup();
  rollup[0] = { ...rollup[0], status: "IN_PROGRESS", conclusion: "", completedAt: null };
  return [...rollup, { ...clone(realPr.statusContext), state: "PENDING" }];
};

function fleetState(): MockState {
  return {
    repositories: {
      // Fully healthy: config extends the preset, dashboard with nothing pending, one passing PR.
      "moritzbrantner/arpg": {
        files: { "renovate.json": config([PRESET]) },
        issues: [
          {
            number: 82,
            title: "Dependency Dashboard",
            body: healthyDashboard,
            author: RENOVATE_BOT,
          },
          {
            number: 90,
            title: "Human issue mentioning Dependency Dashboard",
            body: "## Pending Approval\n\n - [ ] <!-- approve-branch=renovate/fake-9.x -->not a dashboard",
            author: { login: "moritzbrantner", is_bot: false },
          },
        ],
        pulls: [pr(171, "2026-10-16T02:58:55Z", realRollup(), "renovate/rust-1.x")],
        branches: ["renovate/rust-1.x"],
      },
      // Real trimmed dashboard: awaiting schedule, pending approval majors, pending status checks.
      "moritzbrantner/scrabble": {
        files: { "renovate.json": config([PRESET]) },
        issues: [
          {
            number: scrabbleDashboard.number,
            title: scrabbleDashboard.title,
            body: scrabbleDashboard.body,
            author: RENOVATE_BOT,
          },
        ],
      },
      // Bot PRs only (no dashboard): failing, pending, stale, and a 14-day PR without checks.
      "moritzbrantner/physics-engine": {
        files: { ".github/renovate.json": config([`${PRESET}:default`]) },
        pulls: [
          pr(281, "2026-10-16T02:58:55Z", failingRollup(), "renovate/rust-1.x"),
          pr(282, "2026-10-17T03:00:00Z", pendingRollup(), "renovate/geometry-kernels-digest"),
          pr(250, "2026-09-17T12:00:00Z", realRollup(), "renovate/lock-file-maintenance"),
          pr(260, "2026-10-03T11:00:00Z", [], "renovate/serde-1.x"),
        ],
      },
      // Config present, no Renovate activity at all: owner check for the app.
      "moritzbrantner/my-farm": {
        files: { ".renovaterc.json": config([PRESET]) },
      },
      // Config that does not extend the central preset; a renovate/* branch proves the app.
      "moritzbrantner/ui": {
        files: { "renovate.json": config(["config:recommended"]) },
        branches: ["renovate/react-monorepo"],
      },
      // No config, no activity.
      "moritzbrantner/zoo": {},
      // Must never be queried.
      "moritzbrantner/mmorpg": { files: { "renovate.json": config([PRESET]) } },
    },
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}

function checkout(root: string, dir: string, options: { id?: string; origin?: string }): void {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  if (options.origin) git(path, "remote", "add", "origin", options.origin);
  if (options.id) {
    writeFileSync(
      join(path, ".repository.toml"),
      [
        "schema_version = 1",
        `id = "${options.id}"`,
        'kind = "app"',
        'status = "active"',
        'summary = "fixture"',
        "depends_on = []",
        "consumed_by = []",
        "supersedes = []",
        "replaced_by = []",
        "",
      ].join("\n"),
    );
  }
}

function fleetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-fleet-renovate-"));
  checkout(root, "arpg", { origin: "git@github.com:moritzbrantner/arpg.git" }); // no metadata
  checkout(root, "scrabble", { id: "moritzbrantner/scrabble" });
  checkout(root, "physics-engine", {
    id: "moritzbrantner/physics-engine",
    origin: "https://github.com/moritzbrantner/physics-engine.git",
  });
  checkout(root, "physics-engine-bounds-183", {
    origin: "https://github.com/moritzbrantner/physics-engine.git",
  }); // duplicate worktree-style checkout
  checkout(root, "my-farm", { id: "moritzbrantner/my-farm" });
  checkout(root, "ui", { id: "moritzbrantner/ui" });
  checkout(root, "zoo", { origin: "https://github.com/moritzbrantner/zoo" });
  checkout(root, "mmorpg", { id: "moritzbrantner/mmorpg" });
  checkout(root, "mmorpg-click-153", { origin: "git@github.com:moritzbrantner/mmorpg.git" });
  return root;
}

const strip = (value: Envelope) => ({ ...value, durationMs: 0 });

function entries(result: Envelope): Entry[] {
  return result.data.repositories as Entry[];
}

function entry(result: Envelope, repository: string): Entry {
  const found = entries(result).find((candidate) => candidate.repository === repository);
  expect(found).toBeDefined();
  return found!;
}

function kinds(value: Entry): string[] {
  return value.actions.map((action) => action.kind).toSorted();
}

async function runFleet(state = fleetState(), repositories?: string[]) {
  const report = await loadReport();
  const github = mockGithub(state);
  const root = fleetRoot();
  const result = report(root, {
    run: github.run,
    now: NOW,
    ...(repositories ? { repositories } : {}),
  });
  return { result, github, root };
}

test("default fleet run reports every repository once, informationally, with the envelope", async () => {
  const { result } = await runFleet();
  expect(result.schemaVersion).toBe(1);
  expect(result.operation).toBe("fleet-renovate");
  expect(result.data.schemaVersion).toBe("coding-tooling/fleet-renovate/v1");
  expect(result.diagnostics).toEqual([]);
  // Failing bot PRs, pending majors and missing config never turn the report into `failed`.
  expect(result.status).toBe("passed");
  expect(entries(result).map((value) => value.repository)).toEqual([
    "moritzbrantner/arpg",
    "moritzbrantner/my-farm",
    "moritzbrantner/physics-engine",
    "moritzbrantner/scrabble",
    "moritzbrantner/ui",
    "moritzbrantner/zoo",
  ]);
});

test("a fully healthy repository has config, an installed app, a passing PR and no actions", async () => {
  const { result } = await runFleet();
  const arpg = entry(result, "moritzbrantner/arpg");
  expect(arpg.config).toEqual({ present: true, path: "renovate.json", extendsCentralPreset: true });
  expect(arpg.app).toBe("installed");
  // The bot-authored dashboard is chosen, not the human issue that mentions it.
  expect(arpg.dashboard.issue).toBe(82);
  expect(arpg.dashboard.awaitingSchedule).toEqual([]);
  expect(arpg.dashboard.pendingApproval).toEqual([]);
  expect(arpg.dashboard.pendingStatusChecks).toEqual([]);
  expect(arpg.dashboard.openPrs).toEqual([
    {
      number: 171,
      title: "chore(deps): update rust-1.x",
      ageDays: 1,
      checks: "passing",
    },
  ]);
  expect(arpg.actions).toEqual([]);
});

test("missing config yields needs-config and a normal-PR add-config action naming the preset", async () => {
  const { result } = await runFleet();
  const zoo = entry(result, "moritzbrantner/zoo");
  expect(zoo.config).toEqual({ present: false, path: null, extendsCentralPreset: false });
  expect(zoo.app).toBe("needs-config");
  expect(zoo.dashboard.issue).toBeNull();
  expect(zoo.dashboard.openPrs).toEqual([]);
  expect(kinds(zoo)).toEqual(["add-config"]);
  const action = zoo.actions[0]!;
  expect(action.owner).toBe(false);
  expect(action.message).toContain("renovate.json");
  expect(action.message).toContain(PRESET);
});

test("a config that does not extend the central preset is reported, with branch-proven app", async () => {
  const { result } = await runFleet();
  const ui = entry(result, "moritzbrantner/ui");
  expect(ui.config).toEqual({ present: true, path: "renovate.json", extendsCentralPreset: false });
  expect(ui.app).toBe("installed");
  expect(kinds(ui)).toEqual(["extend-central-preset"]);
});

test("config without any Renovate activity is an owner check for the app installation", async () => {
  const { result } = await runFleet();
  const farm = entry(result, "moritzbrantner/my-farm");
  expect(farm.config).toEqual({
    present: true,
    path: ".renovaterc.json",
    extendsCentralPreset: true,
  });
  expect(farm.app).toBe("unknown");
  expect(kinds(farm)).toEqual(["owner-install-app"]);
  expect(farm.actions[0]!.owner).toBe(true);
});

test("parses awaiting schedule, pending-approval majors and pending checks from the real dashboard", async () => {
  const { result } = await runFleet();
  const scrabble = entry(result, "moritzbrantner/scrabble");
  expect(scrabble.app).toBe("installed");
  expect(scrabble.dashboard.issue).toBe(36);
  expect(scrabble.dashboard.pendingApproval).toEqual([
    {
      branch: "renovate/actions-cache-6.x",
      title: "chore(deps): update actions/cache action to v6",
    },
    { branch: "renovate/ubuntu-26.x", title: "chore(deps): update dependency ubuntu to v26" },
  ]);
  expect(scrabble.dashboard.awaitingSchedule).toEqual([
    {
      branch: "renovate/playwright-monorepo",
      title: "chore(deps): update dependency @playwright/test to v1.64.0",
    },
    { branch: "renovate/oxfmt-0.x", title: "chore(deps): update dependency oxfmt to v0.73.0" },
    {
      branch: "renovate/oxlint-monorepo",
      title: "chore(deps): update dependency oxlint to v1.88.0",
    },
    {
      branch: "renovate/mcr.microsoft.com-playwright-1.x",
      title: "chore(deps): update mcr.microsoft.com/playwright docker tag to v1.64.1",
    },
    { branch: "renovate/lock-file-maintenance", title: "chore(deps): lock file maintenance" },
  ]);
  expect(scrabble.dashboard.pendingStatusChecks).toEqual([
    {
      branch: "renovate/axe-core-playwright-4.x",
      title: "chore(deps): update dependency @axe-core/playwright to v4.14.0",
    },
  ]);
  expect(scrabble.dashboard.openPrs).toEqual([]);
  // Majors keep dashboard approval: the report recommends approving, never does it.
  expect(kinds(scrabble)).toEqual(["approve-majors-in-dashboard"]);
});

test("unknown dashboard sections are ignored rather than treated as errors", async () => {
  const state = fleetState();
  const body = `${scrabbleDashboard.body}\n\n## Totally New Section\n\n - [ ] <!-- new-thing=renovate/x -->something\n\n## Pending Approval\n`;
  state.repositories["moritzbrantner/scrabble"]!.issues![0]!.body = body;
  const { result } = await runFleet(state, ["moritzbrantner/scrabble"]);
  expect(result.status).toBe("passed");
  expect(result.diagnostics).toEqual([]);
  const scrabble = entry(result, "moritzbrantner/scrabble");
  expect(scrabble.dashboard.pendingApproval.map((item) => item.branch)).toEqual([
    "renovate/actions-cache-6.x",
    "renovate/ubuntu-26.x",
  ]);
  expect(JSON.stringify(scrabble.dashboard)).not.toContain("renovate/x");
});

test("open bot PRs report age and checks; failing and stale PRs become actions", async () => {
  const { result } = await runFleet();
  const physics = entry(result, "moritzbrantner/physics-engine");
  expect(physics.config).toEqual({
    present: true,
    path: ".github/renovate.json",
    extendsCentralPreset: true,
  });
  // Renovate PRs alone prove the app is installed.
  expect(physics.app).toBe("installed");
  expect(physics.dashboard.issue).toBeNull();
  expect(
    physics.dashboard.openPrs.map(({ number, ageDays, checks }) => ({ number, ageDays, checks })),
  ).toEqual([
    { number: 250, ageDays: 30, checks: "passing" },
    { number: 260, ageDays: 14, checks: "none" },
    { number: 281, ageDays: 1, checks: "failing" },
    { number: 282, ageDays: 0, checks: "pending" },
  ]);
  const actions = physics.actions
    .map((action) => ({ kind: action.kind, pullRequest: action.pullRequest }))
    .toSorted((left, right) => left.kind.localeCompare(right.kind));
  // Exactly 14 days is not stale; pending checks are not an action.
  expect(actions).toEqual([
    { kind: "fix-failing-renovate-pr", pullRequest: 281 },
    { kind: "stale-pr", pullRequest: 250 },
  ]);
});

test("mmorpg is excluded by default, listed as excluded and never queried", async () => {
  const { result, github } = await runFleet();
  expect(result.data.excluded).toEqual(["moritzbrantner/mmorpg"]);
  expect(entries(result).some((value) => value.repository.includes("mmorpg"))).toBe(false);
  expect(github.calls.filter((call) => call.join(" ").includes("mmorpg"))).toEqual([]);
});

test("--repo restricts the report to the named subset without enumerating the fleet", async () => {
  const { result, github } = await runFleet(fleetState(), [
    "moritzbrantner/scrabble",
    "moritzbrantner/arpg",
  ]);
  expect(result.status).toBe("passed");
  expect(entries(result).map((value) => value.repository)).toEqual([
    "moritzbrantner/arpg",
    "moritzbrantner/scrabble",
  ]);
  const queried = new Set(
    github.calls
      .filter((call) => call[0] === "gh")
      .flatMap((call) => call.join(" ").match(/moritzbrantner\/[a-z0-9-]+/g) ?? []),
  );
  expect([...queried].toSorted()).toEqual(["moritzbrantner/arpg", "moritzbrantner/scrabble"]);
});

test("a GitHub read failure makes the report unavailable, naming the repository", async () => {
  const state = fleetState();
  state.repositories["moritzbrantner/scrabble"]!.fail = {
    on: ["issues"],
    stderr: "HTTP 502: Bad Gateway (https://api.github.com/graphql)\n",
  };
  const { result } = await runFleet(state, ["moritzbrantner/scrabble", "moritzbrantner/arpg"]);
  expect(result.operation).toBe("fleet-renovate");
  expect(result.status).toBe("unavailable");
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.diagnostics)).toContain("moritzbrantner/scrabble");
});

test("a non-404 contents failure is unavailable, not a missing config", async () => {
  const state = fleetState();
  state.repositories["moritzbrantner/zoo"]!.fail = {
    on: ["contents"],
    stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n",
  };
  const { result } = await runFleet(state, ["moritzbrantner/zoo"]);
  expect(result.status).toBe("unavailable");
  expect(JSON.stringify(result.diagnostics)).toContain("moritzbrantner/zoo");
  const zoo = entries(result).find((value) => value.repository === "moritzbrantner/zoo");
  expect(zoo?.actions.some((action) => action.kind === "add-config") ?? false).toBe(false);
});

test("the report is deterministic for the same GitHub state and clock", async () => {
  const report = await loadReport();
  const root = fleetRoot();
  const first = report(root, { run: mockGithub(fleetState()).run, now: NOW });
  const second = report(root, { run: mockGithub(fleetState()).run, now: NOW });
  expect(JSON.stringify(strip(second))).toBe(JSON.stringify(strip(first)));
});

test("only read calls are ever made", async () => {
  const { github } = await runFleet();
  expect(github.calls.length).toBeGreaterThan(0);
  expect(github.calls.filter((call) => !isReadOnlyCall(call))).toEqual([]);
});

function cli(state: MockState, args: string[]) {
  const work = mkdtempSync(join(tmpdir(), "coding-tooling-fleet-renovate-cli-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  const statePath = join(work, "state.json");
  const logPath = join(work, "calls.log");
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, "");
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, "fake-gh.ts")}" "$@"\n`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "src", "router.ts"), "fleet", "renovate", ...args],
    {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        FLEET_RENOVATE_MOCK_STATE: statePath,
        FLEET_RENOVATE_MOCK_LOG: logPath,
      },
      timeout: 60_000,
    },
  );
  const calls = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { result, calls };
}

test("CLI: repeated --repo reports the subset as JSON and exits 0", () => {
  const root = fleetRoot();
  const { result, calls } = cli(fleetState(), [
    "--root",
    root,
    "--repo",
    "moritzbrantner/zoo",
    "--repo",
    "moritzbrantner/scrabble",
    "--json",
  ]);
  expect(result.status).toBe(0);
  const envelope = JSON.parse(result.stdout) as Envelope;
  expect(envelope.operation).toBe("fleet-renovate");
  expect(envelope.status).toBe("passed");
  expect(entries(envelope).map((value) => value.repository)).toEqual([
    "moritzbrantner/scrabble",
    "moritzbrantner/zoo",
  ]);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((call) => !isReadOnlyCall(call))).toEqual([]);
});

test("CLI: unreadable GitHub data exits 2 with status unavailable", () => {
  const state = fleetState();
  state.repositories["moritzbrantner/arpg"]!.fail = {
    on: ["contents", "issues", "pulls", "branches", "repo"],
    stderr: "error connecting to api.github.com\n",
  };
  const { result } = cli(state, ["--root", fleetRoot(), "--repo", "moritzbrantner/arpg", "--json"]);
  expect(result.status).toBe(2);
  const envelope = JSON.parse(result.stdout) as Envelope;
  expect(envelope.operation).toBe("fleet-renovate");
  expect(envelope.status).toBe("unavailable");
});
