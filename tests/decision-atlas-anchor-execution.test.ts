/**
 * Independent acceptance for moritzbrantner/coding-tooling#340:
 * Decision Atlas `test:` anchors linked to execution evidence, following
 * Atlas 4.3.4-4.3.8 and the owner decisions of 2026-10-17 (issue comment).
 *
 * Which existing report shape carries per-test-case results?
 *   - The `coding-tooling run --report <path>` envelope (`writeReport` in
 *     src/core.ts) does NOT. Its `data.results[].testExecution` keeps only
 *     aggregate counts (passedCases, failedCases, ...), no test names, and the
 *     envelope records no revision. It cannot be matched by test name and
 *     revision, so it is not an evidence source for anchors.
 *   - The test-case evidence artifact (`TestCaseEvidenceArtifact` in
 *     src/test-case-evidence.ts, docs/http-case-evidence.md) DOES: schema
 *     version 1 JSON `{ schemaVersion: 1, runId, revision, capability,
 *     component, cases: [{ id, outcome: "passed"|"failed"|"skipped"|"todo" }] }`,
 *     written by runner adapters/harnesses under
 *     `.artifacts/coding-tooling/test-case-evidence/<runId>.json`.
 *   This file pins that existing artifact shape as the anchor report format.
 *
 * Pinned seam (the smallest one on top of the existing shape):
 *
 * Report format: a TestCaseEvidenceArtifact. Only `revision` (string) and
 *   `cases[]` are read; `runId`, `capability` and `component` may be present
 *   and are ignored (4.3.7: matched by test name and revision only, no other
 *   checks). A case matches a `test:` anchor when `id === "<path>::<symbol>"`,
 *   i.e. the anchor target exactly as authored, without any `@sha` pin.
 *   `skipped` / `todo` outcomes do not count as evidence (they behave as absent).
 *
 * Where reports are found:
 *   - declared path: every `*.json` file directly in the default directory
 *     `<root>/.artifacts/coding-tooling/test-case-evidence/` of the working
 *     tree (the directory existing producers already write to). No config is
 *     needed.
 *   - `daq ... --report <path>`: one more report file, resolved against
 *     `--root` like `coding-tooling run --report`. It is added to the declared
 *     reports, not a replacement. Function option: `reports: string[]`.
 *
 * Function: `resolveAtlasAnchors(root, index, { decisionIds?, reports?,
 *   runTests? })`. Every result whose `anchor.kind === "test"` gains
 *     execution: { status: "passed" | "failed" | "not-run"; revision?: string;
 *                  current: boolean; source?: "report" | "run";
 *                  reportPath?: string }
 *   `src:` and `proof:` results carry NO `execution` key.
 *   - `current` is true only when `revision` equals the anchor's resolved
 *     `revision` (4.3.8).
 *   - `not-run` is exactly `{ status: "not-run", current: false }`.
 *   - `source: "report"` carries `reportPath`: the root-relative POSIX path
 *     for a declared report, the argument as given for `--report`.
 *
 * Selection when several reports match one anchor:
 *   1. a result at the anchor's resolved revision wins (current);
 *   2. otherwise the result at the newest revision wins, where newest is git
 *      ancestry order of the checkout (the nearest ancestor of the resolved
 *      revision), never file name or file modification time;
 *   3. several results at the same revision: `failed` beats `passed`.
 *
 * Malformed report (bad JSON, wrong schemaVersion, non-string revision,
 *   non-array cases): ignored with a diagnostic. `daq` still exits 0, keeps
 *   stdout valid, and writes a stderr line naming the report path; other
 *   reports are still used. The function never throws for it.
 *
 * Running (`daq ... --run-tests`, function `runTests: true`): only on request.
 *   For a resolved, unpinned `test:` anchor with no current report result, the
 *   single anchored test is run in the checkout with the repo's runner
 *   (`bun test <file> -t <name>` or the declared test capability for
 *   TypeScript, `cargo test <name> -- --exact` for Rust). Result:
 *   `{ status: "passed" | "failed", revision: <HEAD>, current: true,
 *   source: "run" }`. A current report result is preferred: then nothing runs.
 *   Without the flag nothing is ever executed.
 *
 * Display: in `daq get <ID> --root <checkout> --resolve-anchors --json`,
 *   `entries[].evidence[].anchors[].resolution.execution` equals the function's
 *   `execution`. The text output prints `execution: <status>` for each `test:`
 *   anchor; a non-current result prints `execution: <status> at <sha>` (at
 *   least the first 12 hex), a current one never prints `<status> at`.
 *   Preview: `renderAtlasPreview(index, { resolutions })`, with `resolutions`
 *   from `resolveAtlasAnchors`, prints the same `execution: ...` text per
 *   `test:` anchor. Without `resolutions` it is unchanged.
 *
 * Report-only (4.3.5): execution never changes `checked`, `completed/total`,
 *   `implementation.verification` ("unverified") or `provenance.implementation`
 *   ("not-verified"), and nothing claims a Decision is "verified".
 *
 * Gaps: cross-repository `test:` anchors and pinned `@sha` test anchors under
 *   `--run-tests` are not covered; the Rust run test is skipped when cargo is
 *   unavailable; CI artifact download is out of scope (a downloaded artifact is
 *   given with `--report`).
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveAtlasAnchors } from "../src/decision-atlas-anchors.ts";
import { indexRepository } from "../src/decision-atlas-cli.ts";
import { renderAtlasPreview } from "../src/decision-atlas-preview.ts";
import { daqCommand } from "../src/daq-cli.ts";
import { evidenceProgress, type AtlasIndex } from "../src/decision-atlas.ts";

const repository = "moritzbrantner/execution-fixture";
const sourcePath = "docs/decisions/atlas.md";
const declaredDir = ".artifacts/coding-tooling/test-case-evidence";
const proofUrl = `https://github.com/${repository}/blob/${"d".repeat(40)}/docs/proof.md`;

interface Execution {
  status: "passed" | "failed" | "not-run";
  revision?: string;
  current: boolean;
  source?: "report" | "run";
  reportPath?: string;
}
interface Result {
  decisionId: string;
  evidence: string;
  anchor: { kind: string; path?: string; symbol?: string };
  status: string;
  revision?: string;
  execution?: Execution;
}
interface Options {
  decisionIds?: ReadonlySet<string>;
  reports?: string[];
  runTests?: boolean;
}
const resolveWith = resolveAtlasAnchors as unknown as (
  root: string,
  index: AtlasIndex,
  options?: Options,
) => Result[];
const preview = renderAtlasPreview as unknown as (
  index: AtlasIndex,
  options?: { resolutions?: Result[] },
) => string;

// ---------------------------------------------------------------- fixtures

const mathTs = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const mathTestTs = `import { describe, expect, test } from "bun:test";

import { add } from "../src/math.ts";

test("adds", () => {
  expect(add(1, 2)).toBe(3);
});

test("subtracts", () => {
  expect(add(1, 2)).toBe(0);
});

describe("Math", () => {
  test("multiplies", () => {
    expect(2 * 3).toBe(6);
  });
});
`;

/** Writes a marker next to the checkout root as soon as the file is loaded by a runner. */
const markerTestTs = `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(import.meta.dir, "..", "ran.marker"), "ran\\n");

test("writes marker", () => {});
`;

const atlas = `# Execution fixture

## Entries

- **1** Execution
  - **1.1** Tests
    - **1.1.1** [decision] Client math works.
      - [x] Adds — src: src/math.ts::add; test: tests/math.test.ts::adds; proof: ${proofUrl}
      - [ ] Subtracts — test: tests/math.test.ts::subtracts
      - [ ] Multiplies — test: tests/math.test.ts::Math > multiplies
      - [ ] Plain evidence without anchors.
    - **1.1.2** [decision] The marker test is never run unasked.
      - [ ] Marker — test: tests/marker.test.ts::writes marker
`;

const ADDS = "tests/math.test.ts::adds";
const SUBTRACTS = "tests/math.test.ts::subtracts";
const MULTIPLIES = "tests/math.test.ts::Math > multiplies";
const MARKER = "tests/marker.test.ts::writes marker";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Checkout {
  root: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (message: string) => string;
  /** Commits, oldest first; the last one is HEAD. */
  commits: string[];
}

function checkout(files: Record<string, string>, extraCommits = 0): Checkout {
  const root = mkdtempSync(join(tmpdir(), "atlas-execution-"));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, "utf8");
  };
  const commits: string[] = [];
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-qm", message);
    const sha = git("rev-parse", "HEAD");
    commits.push(sha);
    return sha;
  };
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Atlas execution acceptance");
  git("config", "user.email", "atlas@example.invalid");
  git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  write(".gitignore", ".artifacts/\nci/\nran.marker\n");
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit("fixture");
  for (let i = 1; i <= extraCommits; i++) {
    write("NOTES.md", `revision ${i}\n`);
    commit(`revision ${i}`);
  }
  return { root, git, write, commit, commits };
}

function fixtureRepo(extraCommits = 0): Checkout {
  return checkout(
    {
      "package.json": JSON.stringify({ name: "execution-fixture", scripts: { test: "bun test" } }),
      "src/math.ts": mathTs,
      "tests/math.test.ts": mathTestTs,
      "tests/marker.test.ts": markerTestTs,
      [sourcePath]: atlas,
    },
    extraCommits,
  );
}

function head(repo: Checkout): string {
  return repo.commits.at(-1)!;
}

function indexAt(repo: Checkout): AtlasIndex {
  return indexRepository({
    root: repo.root,
    repository,
    source: sourcePath,
    format: "numbered-list",
    revision: head(repo),
  });
}

type Outcome = "passed" | "failed" | "skipped" | "todo";

/** A TestCaseEvidenceArtifact (src/test-case-evidence.ts), the existing per-case shape. */
function report(revision: string, cases: Record<string, Outcome>): string {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: "ci-" + revision.slice(0, 8),
        revision,
        capability: "test:unit",
        component: ".",
        cases: Object.entries(cases).map(([id, outcome]) => ({ id, outcome })),
      },
      null,
      2,
    ) + "\n"
  );
}

function declare(repo: Checkout, name: string, content: string, mtimeSeconds?: number): string {
  const path = `${declaredDir}/${name}`;
  repo.write(path, content);
  if (mtimeSeconds !== undefined) utimesSync(join(repo.root, path), mtimeSeconds, mtimeSeconds);
  return path;
}

function executionOf(results: Result[], target: string): Execution | undefined {
  const matches = results.filter(
    (r) => r.anchor.kind === "test" && `${r.anchor.path}::${r.anchor.symbol}` === target,
  );
  if (matches.length !== 1) throw new Error(`expected one test result for ${target}`);
  expect(matches[0]!.status).toBe("resolved");
  return matches[0]!.execution;
}

async function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = await daqCommand(argv, {
    write: (message) => {
      out += message;
    },
    error: (message) => {
      err += message;
    },
  });
  return { code, out, err };
}

interface JsonAnchor {
  kind: string;
  path?: string;
  symbol?: string;
  resolution?: { status: string; revision?: string; execution?: Execution };
}
interface JsonEntry {
  id: string;
  evidence: { text: string; checked: boolean; anchors?: JsonAnchor[] }[];
  [key: string]: unknown;
}

async function getJson(repo: Checkout, id: string, extra: string[] = []) {
  const run = await capture([
    "get",
    id,
    "--root",
    repo.root,
    "--resolve-anchors",
    "--json",
    ...extra,
  ]);
  expect(run.code).toBe(0);
  const parsed = JSON.parse(run.out) as { entries: JsonEntry[] };
  return { ...run, entries: parsed.entries };
}

function jsonExecution(entries: JsonEntry[], target: string): Execution | undefined {
  for (const entry of entries)
    for (const item of entry.evidence)
      for (const anchor of item.anchors ?? [])
        if (anchor.kind === "test" && `${anchor.path}::${anchor.symbol}` === target)
          return anchor.resolution?.execution;
  throw new Error("no test anchor " + target);
}

const notRun: Execution = { status: "not-run", current: false };

const progressLine = (out: string) => out.split("\n").filter((line) => /\d+\/\d+/u.test(line));
const count = (page: string) => page.match(/Implementation evidence: \d+\/\d+ checked/gu);
const executionLines = (output: string) =>
  output.split("\n").filter((line) => line.includes("execution:"));
const withoutExecution = (output: string) =>
  output
    .split("\n")
    .filter((line) => !line.includes("execution:"))
    .join("\n");

// ---------------------------------------------------------------- reports

test("a passing case at the current revision is passed and current, with its report path", () => {
  const repo = fixtureRepo();
  const path = declare(repo, "run-1.json", report(head(repo), { [ADDS]: "passed" }));
  const results = resolveWith(repo.root, indexAt(repo));
  expect(executionOf(results, ADDS)).toEqual({
    status: "passed",
    revision: head(repo),
    current: true,
    source: "report",
    reportPath: path,
  });
});

test("a passing case at an older revision is passed but not current, with that revision", async () => {
  const repo = fixtureRepo(1);
  const [old] = repo.commits;
  const path = declare(repo, "old.json", report(old!, { [ADDS]: "passed" }));
  const results = resolveWith(repo.root, indexAt(repo));
  expect(executionOf(results, ADDS)).toEqual({
    status: "passed",
    revision: old!,
    current: false,
    source: "report",
    reportPath: path,
  });

  const text = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("execution: passed at " + old!.slice(0, 12));
});

test("a failed case is failed; text shows it and a current pass never says 'at'", async () => {
  const repo = fixtureRepo();
  declare(
    repo,
    "run.json",
    report(head(repo), { [ADDS]: "passed", [SUBTRACTS]: "failed", [MULTIPLIES]: "passed" }),
  );
  const results = resolveWith(repo.root, indexAt(repo));
  expect(executionOf(results, SUBTRACTS)).toMatchObject({
    status: "failed",
    revision: head(repo),
    current: true,
    source: "report",
  });
  expect(executionOf(results, MULTIPLIES)).toMatchObject({ status: "passed", current: true });

  const text = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("execution: failed");
  expect(text.out).toContain("execution: passed");
  expect(text.out).not.toContain("passed at");
  expect(text.out).not.toContain("failed at");
  // One execution line per test: anchor (3 in 1.1.1); src: and proof: have none.
  expect(text.out.match(/execution: /gu)?.length).toBe(3);
});

test("a test absent from every report is not-run; skipped/todo cases do not count", () => {
  const repo = fixtureRepo();
  declare(repo, "a.json", report(head(repo), { [SUBTRACTS]: "skipped", [MULTIPLIES]: "todo" }));
  declare(repo, "b.json", report(head(repo), { "tests/other.test.ts::adds": "passed" }));
  // Same test name in another file: the id `<path>::<symbol>` does not match.
  const results = resolveWith(repo.root, indexAt(repo));
  expect(executionOf(results, ADDS)).toEqual(notRun);
  expect(executionOf(results, SUBTRACTS)).toEqual(notRun);
  expect(executionOf(results, MULTIPLIES)).toEqual(notRun);
});

test("with no report anywhere every test anchor is not-run and src/proof carry no execution", () => {
  const repo = fixtureRepo();
  const results = resolveWith(repo.root, indexAt(repo));
  for (const r of results) {
    if (r.anchor.kind === "test") expect(r.execution).toEqual(notRun);
    else expect("execution" in r).toBe(false);
  }
  expect(results.filter((r) => r.anchor.kind !== "test").length).toBe(2);
});

test("multiple reports: current revision wins, else the newest ancestor, else failed beats passed", () => {
  const repo = fixtureRepo(2);
  const [c1, c2, c3] = repo.commits as [string, string, string];
  const now = Math.floor(Date.now() / 1000);
  // File names and modification times deliberately contradict ancestry order.
  declare(repo, "a-newest-name.json", report(c1, { [ADDS]: "failed", [SUBTRACTS]: "passed" }), now);
  const c2Path = declare(
    repo,
    "z-oldest-name.json",
    report(c2, { [ADDS]: "passed", [SUBTRACTS]: "failed", [MULTIPLIES]: "failed" }),
    now - 3600,
  );
  // At the current revision: MULTIPLIES passed in one report and failed in another.
  declare(repo, "m-head-pass.json", report(c3, { [MULTIPLIES]: "passed" }), now - 60);
  const headFail = declare(repo, "n-head-fail.json", report(c3, { [MULTIPLIES]: "failed" }));

  const results = resolveWith(repo.root, indexAt(repo));
  expect(executionOf(results, ADDS)).toEqual({
    status: "passed",
    revision: c2,
    current: false,
    source: "report",
    reportPath: c2Path,
  });
  expect(executionOf(results, SUBTRACTS)).toEqual({
    status: "failed",
    revision: c2,
    current: false,
    source: "report",
    reportPath: c2Path,
  });
  expect(executionOf(results, MULTIPLIES)).toEqual({
    status: "failed",
    revision: c3,
    current: true,
    source: "report",
    reportPath: headFail,
  });

  // A current result beats an older one even when the older one is newer on disk.
  const repo2 = fixtureRepo(1);
  const [old, now2] = repo2.commits as [string, string];
  declare(repo2, "old.json", report(old, { [ADDS]: "failed" }), now + 3600);
  declare(repo2, "head.json", report(now2, { [ADDS]: "passed" }), now - 3600);
  expect(executionOf(resolveWith(repo2.root, indexAt(repo2)), ADDS)).toMatchObject({
    status: "passed",
    revision: now2,
    current: true,
  });
});

test("reports are found through the declared directory and through --report", async () => {
  const repo = fixtureRepo();
  const declaredPath = declare(repo, "declared.json", report(head(repo), { [ADDS]: "passed" }));
  repo.write("ci/case-report.json", report(head(repo), { [SUBTRACTS]: "failed" }));

  const declaredOnly = await getJson(repo, "1.1.1");
  expect(jsonExecution(declaredOnly.entries, ADDS)).toEqual({
    status: "passed",
    revision: head(repo),
    current: true,
    source: "report",
    reportPath: declaredPath,
  });
  // A report outside the declared directory is not picked up unasked.
  expect(jsonExecution(declaredOnly.entries, SUBTRACTS)).toEqual(notRun);

  const both = await getJson(repo, "1.1.1", ["--report", "ci/case-report.json"]);
  expect(jsonExecution(both.entries, ADDS)).toMatchObject({ status: "passed", current: true });
  expect(jsonExecution(both.entries, SUBTRACTS)).toEqual({
    status: "failed",
    revision: head(repo),
    current: true,
    source: "report",
    reportPath: "ci/case-report.json",
  });

  // Function form of --report.
  const results = resolveWith(repo.root, indexAt(repo), { reports: ["ci/case-report.json"] });
  expect(executionOf(results, SUBTRACTS)).toMatchObject({
    status: "failed",
    reportPath: "ci/case-report.json",
  });
});

test("a run --report envelope (aggregate counts only) is not per-case evidence", () => {
  const repo = fixtureRepo();
  declare(
    repo,
    "run-envelope.json",
    JSON.stringify({
      schemaVersion: 1,
      operation: "run",
      status: "passed",
      data: {
        root: repo.root,
        results: [{ capability: "test:unit", status: "passed", testExecution: { passedCases: 3 } }],
      },
      diagnostics: [],
    }),
  );
  expect(executionOf(resolveWith(repo.root, indexAt(repo)), ADDS)).toEqual(notRun);
});

test("malformed reports are ignored with a diagnostic; valid reports still count; nothing crashes", async () => {
  const repo = fixtureRepo();
  const broken = declare(repo, "broken.json", "{ not json");
  const wrongSchema = declare(
    repo,
    "wrong-schema.json",
    JSON.stringify({ schemaVersion: 2, revision: head(repo), cases: [] }),
  );
  const badFields = declare(
    repo,
    "bad-fields.json",
    JSON.stringify({ schemaVersion: 1, revision: 42, cases: "adds" }),
  );
  declare(repo, "good.json", report(head(repo), { [ADDS]: "passed" }));
  repo.write("ci/bad.json", "[]");

  const results = resolveWith(repo.root, indexAt(repo), { reports: ["ci/bad.json"] });
  expect(executionOf(results, ADDS)).toMatchObject({ status: "passed", current: true });
  expect(executionOf(results, SUBTRACTS)).toEqual(notRun);

  const json = await getJson(repo, "1.1.1", ["--report", "ci/bad.json"]);
  expect(jsonExecution(json.entries, ADDS)).toMatchObject({ status: "passed", current: true });
  for (const path of [broken, wrongSchema, badFields, "ci/bad.json"])
    expect(json.err).toContain(path.split("/").at(-1)!);

  const text = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("execution: passed");
  expect(text.err).toContain("broken.json");
});

// ---------------------------------------------------------------- running

test("--run-tests runs the single anchored bun test at HEAD: passed or failed with source run", async () => {
  const repo = fixtureRepo();
  const json = await getJson(repo, "1.1.1", ["--run-tests"]);
  const runAt = (status: "passed" | "failed"): Execution => ({
    status,
    revision: head(repo),
    current: true,
    source: "run",
  });
  // `adds` passes although `subtracts` in the same file fails: only one case ran.
  expect(jsonExecution(json.entries, ADDS)).toEqual(runAt("passed"));
  expect(jsonExecution(json.entries, SUBTRACTS)).toEqual(runAt("failed"));
  expect(jsonExecution(json.entries, MULTIPLIES)).toEqual(runAt("passed"));

  const results = resolveWith(repo.root, indexAt(repo), { runTests: true });
  expect(executionOf(results, ADDS)).toEqual(runAt("passed"));
}, 120_000);

test("without --run-tests nothing is executed; with it the marker test runs; a current report is preferred", async () => {
  const repo = fixtureRepo();
  const marker = join(repo.root, "ran.marker");

  const json = await getJson(repo, "1.1.2");
  expect(jsonExecution(json.entries, MARKER)).toEqual(notRun);
  const text = await capture(["get", "1.1.2", "--root", repo.root, "--resolve-anchors"]);
  expect(text.out).toContain("execution: not-run");
  expect(executionOf(resolveWith(repo.root, indexAt(repo)), MARKER)).toEqual(notRun);
  expect(existsSync(marker)).toBe(false);

  // A current report result is used instead of running the test.
  const path = declare(repo, "head.json", report(head(repo), { [MARKER]: "passed" }));
  const preferred = await getJson(repo, "1.1.2", ["--run-tests"]);
  expect(jsonExecution(preferred.entries, MARKER)).toMatchObject({
    status: "passed",
    source: "report",
    reportPath: path,
  });
  expect(existsSync(marker)).toBe(false);

  // Sanity: the marker mechanism works once running is requested.
  rmSync(join(repo.root, path));
  const ran = await getJson(repo, "1.1.2", ["--run-tests"]);
  expect(jsonExecution(ran.entries, MARKER)).toEqual({
    status: "passed",
    revision: head(repo),
    current: true,
    source: "run",
  });
  expect(existsSync(marker)).toBe(true);
}, 120_000);

const hasCargo = spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;

test.skipIf(!hasCargo)(
  "--run-tests runs a single Rust #[test] with cargo",
  async () => {
    const repo = checkout({
      "Cargo.toml": '[package]\nname = "execution_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": "pub fn one() -> u32 {\n    1\n}\n",
      "tests/smoke.rs":
        "#[test]\nfn passes() {\n    assert_eq!(execution_fixture::one(), 1);\n}\n\n#[test]\nfn fails() {\n    assert_eq!(execution_fixture::one(), 2);\n}\n",
      [sourcePath]: `# Rust fixture

## Entries

- **1** Rust
  - **1.1** Tests
    - **1.1.1** [decision] Rust tests run on request.
      - [ ] Passes — test: tests/smoke.rs::passes
      - [ ] Fails — test: tests/smoke.rs::fails
`,
    });
    repo.write(".gitignore", ".artifacts/\nci/\nran.marker\ntarget/\n");
    repo.commit("ignore target");
    const json = await getJson(repo, "1.1.1", ["--run-tests"]);
    const runAt = (status: "passed" | "failed"): Execution => ({
      status,
      revision: head(repo),
      current: true,
      source: "run",
    });
    expect(jsonExecution(json.entries, "tests/smoke.rs::passes")).toEqual(runAt("passed"));
    expect(jsonExecution(json.entries, "tests/smoke.rs::fails")).toEqual(runAt("failed"));
  },
  300_000,
);

// ---------------------------------------------------------------- report-only

test("execution never changes checkboxes, progress or verification, and nothing claims verified", async () => {
  const repo = fixtureRepo(1);
  const [old] = repo.commits;
  declare(
    repo,
    "run.json",
    report(head(repo), { [ADDS]: "passed", [SUBTRACTS]: "failed", [MARKER]: "passed" }),
  );
  declare(repo, "old.json", report(old!, { [MULTIPLIES]: "passed" }));
  const index = indexAt(repo);
  const before = JSON.stringify(index);

  const results = resolveWith(repo.root, index);
  expect(JSON.stringify(index)).toBe(before);
  for (const decision of index.decisions) {
    expect(decision.implementation.verification).toBe("unverified");
  }
  expect(index.provenance.implementation).toBe("not-verified");
  expect(evidenceProgress(index.decisions.find((d) => d.id === "1.1.1")!)).toMatchObject({
    completed: 1,
    total: 4,
  });

  const plain = await capture(["get", "1.1.1", "--root", repo.root, "--json"]);
  const plainEntries = (JSON.parse(plain.out) as { entries: JsonEntry[] }).entries;
  const withExecution = await getJson(repo, "1.1.1");
  const strip = (entries: JsonEntry[]) =>
    entries.map((entry) => ({
      ...entry,
      evidence: entry.evidence.map((item) => ({
        text: item.text,
        checked: item.checked,
        anchors: (item.anchors ?? []).map(({ resolution: _r, ...anchor }) => anchor),
      })),
    }));
  expect(strip(withExecution.entries)).toEqual(strip(plainEntries));

  const plainText = await capture(["get", "1.1.1", "--root", repo.root]);
  const text = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(progressLine(text.out).filter((line) => !line.includes("execution:"))).toEqual(
    progressLine(plainText.out),
  );
  expect(text.out).toContain("[x] Adds");
  expect(text.out).toContain("[ ] Subtracts");

  const html = preview(index, { resolutions: results });
  const htmlPlain = preview(index);
  expect(count(html)).toEqual(count(htmlPlain));
  expect(html.match(/<input type="checkbox" disabled checked>/gu)?.length).toBe(
    htmlPlain.match(/<input type="checkbox" disabled checked>/gu)?.length,
  );

  // Execution output itself never says "verified" (existing negations such as
  // "parent not verified" elsewhere in the output are unchanged baseline text).
  expect(executionLines(text.out).length).toBe(3);
  expect(executionLines(text.out).join("\n")).not.toMatch(/verified/iu);
  expect(html.match(/execution: [^<]*/gu)?.join("\n") ?? "").not.toMatch(/verified/iu);
  const executions = results.flatMap((r) => (r.execution ? [r.execution] : []));
  expect(executions.length).toBe(4);
  expect(JSON.stringify(executions)).not.toMatch(/verified/iu);
  // The non-execution text is byte-identical to resolution without evidence.
  rmSync(join(repo.root, ".artifacts"), { recursive: true, force: true });
  const noEvidence = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(withoutExecution(text.out)).toBe(withoutExecution(noEvidence.out));
});

test("the preview shows execution per test anchor and is unchanged without resolutions", () => {
  const repo = fixtureRepo(1);
  const [old] = repo.commits;
  declare(repo, "run.json", report(head(repo), { [SUBTRACTS]: "failed" }));
  declare(repo, "old.json", report(old!, { [ADDS]: "passed" }));
  const index = indexAt(repo);
  const results = resolveWith(repo.root, index);

  const html = preview(index, { resolutions: results });
  expect(html).toContain("execution: passed at " + old!.slice(0, 12));
  expect(html).toContain("execution: failed");
  expect(html).toContain("execution: not-run");
  // Four test: anchors in the fixture (three under 1.1.1, one under 1.1.2).
  expect(html.match(/execution: /gu)?.length).toBe(4);
  expect(preview(index)).not.toContain("execution:");
  expect(preview(index)).toBe(renderAtlasPreview(index));
});

test("execution output is deterministic", async () => {
  const repo = fixtureRepo(2);
  const [c1, c2] = repo.commits as [string, string, string];
  declare(repo, "x.json", report(c1, { [ADDS]: "failed" }));
  declare(repo, "y.json", report(c2, { [ADDS]: "passed", [SUBTRACTS]: "failed" }));
  declare(repo, "z.json", report(head(repo), { [MULTIPLIES]: "passed" }));
  const first = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors", "--json"]);
  const second = await capture([
    "get",
    "1.1.1",
    "--root",
    repo.root,
    "--resolve-anchors",
    "--json",
  ]);
  expect(first.code).toBe(0);
  expect(second.out).toBe(first.out);
  const firstText = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  const secondText = await capture(["get", "1.1.1", "--root", repo.root, "--resolve-anchors"]);
  expect(secondText.out).toBe(firstText.out);
  expect(JSON.stringify(resolveWith(repo.root, indexAt(repo)))).toBe(
    JSON.stringify(resolveWith(repo.root, indexAt(repo))),
  );
  expect(first.out).toContain('"execution"');
});
