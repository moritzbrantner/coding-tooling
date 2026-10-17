import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Report-only execution evidence for one `test:` anchor (Atlas 4.3.7-4.3.8).
 * `current` is true only when `revision` is the anchor's resolved revision; an
 * older result stays visible as "passed at <sha>". It never verifies a Decision
 * and never changes a checkbox or the progress count (4.3.5).
 */
export interface AnchorExecution {
  status: "passed" | "failed" | "not-run";
  revision?: string;
  current: boolean;
  source?: "report" | "run";
  /** Root-relative POSIX path of a declared report, or the `--report` argument as given. */
  reportPath?: string;
}

/** `execution: <status>`, plus ` at <sha12>` for a result that is not at the anchor's revision. */
export function executionText(execution: AnchorExecution): string {
  return (
    "execution: " +
    execution.status +
    (!execution.current && execution.revision ? " at " + execution.revision.slice(0, 12) : "")
  );
}

/** Repository-declared directory of `TestCaseEvidenceArtifact` JSON files. */
export const declaredCaseReportDirectory = ".artifacts/coding-tooling/test-case-evidence";

const maxReportBytes = 4 * 1024 * 1024;
const notRun: AnchorExecution = { status: "not-run", current: false };

interface CaseResult {
  outcome: "passed" | "failed";
  revision: string;
  reportPath: string;
}

/** Per-case results of every readable report, keyed by case id (`<path>::<symbol>`). */
export type CaseReports = Map<string, CaseResult[]>;

function readReport(
  absolutePath: string,
  reportPath: string,
  into: CaseReports,
  diagnostic: (message: string) => void,
): void {
  const ignore = (why: string) =>
    diagnostic(`Decision Atlas anchors: ignoring test-case evidence report ${reportPath}: ${why}`);
  let parsed: unknown;
  try {
    if (statSync(absolutePath).size > maxReportBytes) return ignore("exceeds the 4 MiB budget");
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return ignore(error instanceof SyntaxError ? "invalid JSON" : "cannot be read");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return ignore("not a TestCaseEvidenceArtifact object");
  const artifact = parsed as { schemaVersion?: unknown; revision?: unknown; cases?: unknown };
  if (artifact.schemaVersion !== 1) return ignore("schemaVersion is not 1");
  if (typeof artifact.revision !== "string" || !artifact.revision)
    return ignore("revision is not a string");
  if (!Array.isArray(artifact.cases)) return ignore("cases is not an array");
  for (const item of artifact.cases as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { id, outcome } = item as { id?: unknown; outcome?: unknown };
    // skipped / todo (and unknown outcomes) are not evidence: they behave as absent.
    if (typeof id !== "string" || (outcome !== "passed" && outcome !== "failed")) continue;
    let results = into.get(id);
    if (!results) into.set(id, (results = []));
    results.push({ outcome, revision: artifact.revision, reportPath });
  }
}

/**
 * Reads every `*.json` file directly in the declared directory of the working
 * tree (sorted by name) plus each extra report path (resolved against `root`).
 * Malformed or unreadable reports are ignored with a diagnostic; never throws.
 */
export function loadCaseReports(
  root: string,
  extra: readonly string[],
  diagnostic: (message: string) => void,
): CaseReports {
  const reports: CaseReports = new Map();
  const directory = join(root, declaredCaseReportDirectory);
  let names: string[] = [];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  for (const name of names)
    readReport(
      join(directory, name),
      `${declaredCaseReportDirectory}/${name}`,
      reports,
      diagnostic,
    );
  for (const path of extra) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) {
      diagnostic(`Decision Atlas anchors: ignoring test-case evidence report ${path}: not found`);
      continue;
    }
    readReport(absolute, path, reports, diagnostic);
  }
  return reports;
}

/** Git ancestry of the checkout an anchor was read from. */
export interface RevisionHistory {
  /** Commits between `revision` and `of` (0 when equal); undefined when not an ancestor. */
  distance(revision: string, of: string): number | undefined;
}

/**
 * Picks the evidence for one case id: a result at `revision` (the anchor's
 * resolved revision) wins; otherwise the nearest git ancestor of it; at one
 * revision `failed` beats `passed`. Report order breaks remaining ties.
 */
export function selectReportExecution(
  results: readonly CaseResult[] | undefined,
  revision: string | undefined,
  history: RevisionHistory,
): AnchorExecution {
  if (!results?.length || !revision) return notRun;
  let best: { result: CaseResult; distance: number } | undefined;
  for (const result of results) {
    // An exact match ranks before an abbreviated or otherwise equivalent revision.
    const distance =
      result.revision === revision ? -1 : history.distance(result.revision, revision);
    if (distance === undefined) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        result.outcome === "failed" &&
        best.result.outcome === "passed")
    )
      best = { result, distance };
  }
  if (!best) return notRun;
  return {
    status: best.result.outcome,
    revision: best.result.revision,
    current: best.result.revision === revision,
    source: "report",
    reportPath: best.result.reportPath,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

function count(output: string, pattern: RegExp): number {
  let total = 0;
  for (const match of output.matchAll(pattern)) total += Number(match[1]);
  return total;
}

const runTimeout = 300_000;

function spawn(command: string, args: string[], cwd: string) {
  const run = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: runTimeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: run.status, output: (run.stdout ?? "") + "\n" + (run.stderr ?? "") };
}

function bunExecutable(): string {
  return /(?:^|[/\\])bun(?:\.exe)?$/u.test(process.execPath) ? process.execPath : "bun";
}

/** `bun test ./<file> -t '^<describe> <name>$'`: exactly this one case, never the rest of the file. */
function runBunTest(root: string, path: string, symbol: string): "passed" | "failed" | undefined {
  // Only a Bun test file (or a Bun repository) is run with Bun; other runners are not guessed.
  let text = "";
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
  const bunRepository = ["bun.lock", "bun.lockb", "bunfig.toml"].some((name) =>
    existsSync(join(root, name)),
  );
  if (!bunRepository && !/["']bun:test["']/u.test(text)) return undefined;
  const pattern = "^" + symbol.split(" > ").map(escapeRegExp).join(" ") + "$";
  const run = spawn(bunExecutable(), ["test", "./" + path, "-t", pattern], root);
  const passed = count(run.output, /^\s*(\d+) pass\s*$/gmu);
  const failed = count(run.output, /^\s*(\d+) fail\s*$/gmu);
  if (failed > 0) return "failed";
  if (run.status === 0 && passed === 1) return "passed";
  return undefined;
}

function crateDirectory(root: string, path: string): string | undefined {
  let directory = dirname(join(root, path));
  while (true) {
    if (existsSync(join(directory, "Cargo.toml"))) return directory;
    if (resolve(directory) === resolve(root)) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * `cargo test [--test <name> | --lib] <path> -- --exact` in the file's crate:
 * an integration test `tests/<name>.rs` runs only that binary; a `src/` file
 * prefixes the module path derived from the file (e.g. `src/a/b.rs` -> `a::b::`).
 */
function runCargoTest(root: string, path: string, symbol: string): "passed" | "failed" | undefined {
  const crate = crateDirectory(root, path);
  if (!crate) return undefined;
  const inCrate = relative(crate, join(root, path)).split(/[/\\]/u);
  const name = symbol
    .split("::")
    .map((part) => part.replace(/^r#/u, ""))
    .join("::");
  let args: string[];
  if (inCrate[0] === "tests" && inCrate.length === 2) {
    args = ["test", "--test", inCrate[1]!.replace(/\.rs$/u, ""), name];
  } else if (inCrate[0] === "src") {
    const modules = inCrate.slice(1);
    const last = modules.pop()!.replace(/\.rs$/u, "");
    if (last !== "mod" && last !== "lib" && last !== "main") modules.push(last);
    if (last === "mod" && modules.length === 0) return undefined;
    const target = inCrate.length === 2 && last === "main" ? [] : ["--lib"];
    args = ["test", ...target, [...modules, name].join("::")];
  } else return undefined;
  const run = spawn("cargo", [...args, "--", "--exact"], crate);
  const passed = count(run.output, /test result: \w+\. (\d+) passed/gu);
  const failed = count(run.output, /test result: \w+\. \d+ passed; (\d+) failed/gu);
  if (failed > 0) return "failed";
  if (run.status === 0 && passed === 1) return "passed";
  return undefined;
}

/**
 * Runs exactly the one anchored test in the checkout at `root` (called only on
 * explicit request). The tracked working tree must equal `head`, so the result
 * is evidence at `head`. Returns not-run when the test cannot be run or the
 * runner output does not show exactly that one case.
 */
export function runAnchoredTest(
  root: string,
  head: string,
  path: string,
  symbol: string,
): AnchorExecution {
  if (isAbsolute(path)) return notRun;
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (status.status !== 0 || status.stdout.trim() !== "") return notRun;
  const outcome = path.endsWith(".rs")
    ? runCargoTest(root, path, symbol)
    : runBunTest(root, path, symbol);
  return outcome ? { status: outcome, revision: head, current: true, source: "run" } : notRun;
}
