// Offline GitHub mock for the `coding-tooling fleet renovate` acceptance tests (#330).
//
// It answers the read-only `gh` calls pinned in tests/fleet-renovate.test.ts, both as an
// injectable in-process runner and, through fake-gh.ts, as a `gh` executable on PATH.
// Every call is recorded so tests can prove that no write was ever attempted.
//
// Behaviour copied from real `gh` (observed 2026-10-17):
// - `gh issue list --author app/renovate` returns NO issues; the issue author filter only
//   matches `renovate[bot]`. `gh pr list` accepts both `app/renovate` and `renovate[bot]`.
// - `gh api repos/<o>/<n>/contents/<path>` for a missing file exits 1 with
//   `gh: Not Found (HTTP 404)` on stderr. Any other failure is a real read failure.
import { spawnSync } from "node:child_process";

export type CommandResult = {
  command: string[];
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type MockAuthor = { login: string; is_bot: boolean };

export type MockIssue = {
  number: number;
  title: string;
  body: string;
  author: MockAuthor;
  url?: string;
};

export type MockPullRequest = {
  number: number;
  title: string;
  createdAt: string;
  headRefName: string;
  statusCheckRollup: unknown[];
  author?: MockAuthor;
  url?: string;
};

export type MockFailureTarget = "contents" | "branches" | "issues" | "pulls" | "repo";

export type MockRepository = {
  /** Path -> file text. Missing paths are 404. */
  files?: Record<string, string>;
  issues?: MockIssue[];
  pulls?: MockPullRequest[];
  branches?: string[];
  /** Read failures (not 404) for the listed call targets. */
  fail?: { on: MockFailureTarget[]; stderr: string };
};

export type MockState = { repositories: Record<string, MockRepository> };

export const RENOVATE_BOT: MockAuthor = { login: "app/renovate", is_bot: true };

function ok(command: string[], value: unknown): CommandResult {
  return { command, status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function fail(command: string[], stderr: string, stdout = ""): CommandResult {
  return { command, status: 1, stdout, stderr };
}

function notFound(command: string[]): CommandResult {
  return fail(
    command,
    "gh: Not Found (HTTP 404)\n",
    JSON.stringify({
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
      status: "404",
    }),
  );
}

const valueFlags = new Set([
  "-R",
  "--repo",
  "-A",
  "--author",
  "--app",
  "-s",
  "--state",
  "-L",
  "--limit",
  "--json",
  "-S",
  "--search",
  "-l",
  "--label",
  "-a",
  "--assignee",
  "-H",
  "--header",
  "--head",
  "-B",
  "--base",
  "-X",
  "--method",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

type Parsed = { positionals: string[]; flags: Map<string, string[]>; booleans: Set<string> };

function parse(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (arg.startsWith("--") && eq > 0) {
        const name = arg.slice(0, eq);
        flags.set(name, [...(flags.get(name) ?? []), arg.slice(eq + 1)]);
      } else if (valueFlags.has(arg)) {
        flags.set(arg, [...(flags.get(arg) ?? []), args[index + 1] ?? ""]);
        index += 1;
      } else booleans.add(arg);
    } else positionals.push(arg);
  }
  return { positionals, flags, booleans };
}

function flag(parsed: Parsed, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = parsed.flags.get(name);
    if (values?.length) return values[values.length - 1];
  }
  return undefined;
}

function project(value: Record<string, unknown>, fields: string | undefined): unknown {
  if (!fields) return value;
  return Object.fromEntries(
    fields
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean)
      .map((field) => [field, field === "state" ? "OPEN" : (value[field] ?? null)]),
  );
}

const WRITE_API_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
const READ_SUBCOMMANDS: Record<string, Set<string>> = {
  issue: new Set(["list", "view"]),
  pr: new Set(["list", "view", "checks"]),
  repo: new Set(["view"]),
};

/** True when a recorded `gh`/`git` call can only read. */
export function isReadOnlyCall(command: string[]): boolean {
  const [program, ...args] = command;
  if (program === "git") {
    const sub = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("/"));
    const joined = args.join(" ");
    return (
      /\bconfig\b.*--get/.test(joined) ||
      (sub.includes("remote") && sub.includes("get-url")) ||
      sub.includes("rev-parse")
    );
  }
  if (program !== "gh") return false;
  const parsed = parse(args);
  const [group, action] = parsed.positionals;
  if (group === "api") {
    const method = (flag(parsed, "-X", "--method") ?? "GET").toUpperCase();
    if (method !== "GET") return false;
    for (const arg of args) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (WRITE_API_FLAGS.has(name)) return false;
    }
    return true;
  }
  return Boolean(group && action && READ_SUBCOMMANDS[group]?.has(action));
}

function repositoryState(state: MockState, name: string | undefined): MockRepository | undefined {
  return name ? state.repositories[name] : undefined;
}

function failing(repository: MockRepository, target: MockFailureTarget): string | undefined {
  return repository.fail?.on.includes(target) ? repository.fail.stderr : undefined;
}

function wrapBase64(text: string): string {
  return (
    (
      Buffer.from(text, "utf8")
        .toString("base64")
        .match(/.{1,60}/g) ?? []
    ).join("\n") + "\n"
  );
}

function api(state: MockState, command: string[], parsed: Parsed): CommandResult {
  if (parsed.flags.has("-q") || parsed.flags.has("--jq") || parsed.booleans.has("-q")) {
    return fail(command, "mock: --jq is not supported; parse JSON in process\n");
  }
  const raw = (parsed.positionals[1] ?? "").replace(/^\//, "");
  const endpoint = raw.split("?")[0]!;
  const match = /^repos\/([^/]+\/[^/]+)\/(contents|branches|git\/matching-refs)(?:\/(.*))?$/.exec(
    endpoint,
  );
  if (!match) return notFound(command);
  const [, name, kind, rest] = match;
  const repository = repositoryState(state, name);
  if (!repository) return notFound(command);
  if (kind === "contents") {
    const reason = failing(repository, "contents");
    if (reason) return fail(command, reason);
    const path = rest ?? "";
    const text = repository.files?.[path];
    if (text === undefined) return notFound(command);
    const accept = (parsed.flags.get("-H") ?? [])
      .concat(parsed.flags.get("--header") ?? [])
      .join(" ");
    if (/vnd\.github(\.v3)?\.raw/.test(accept)) {
      return { command, status: 0, stdout: text, stderr: "" };
    }
    const file = path.split("/").pop()!;
    return ok(command, {
      name: file,
      path,
      type: "file",
      size: Buffer.byteLength(text),
      encoding: "base64",
      content: wrapBase64(text),
    });
  }
  const reason = failing(repository, "branches");
  if (reason) return fail(command, reason);
  const branches = [...(repository.branches ?? []), "main"];
  if (kind === "branches") {
    return ok(
      command,
      branches.map((branch) => ({
        name: branch,
        commit: { sha: "0".repeat(40) },
        protected: false,
      })),
    );
  }
  const prefix = (rest ?? "").replace(/^heads\//, "");
  return ok(
    command,
    branches
      .filter((branch) => branch.startsWith(prefix))
      .map((branch) => ({ ref: `refs/heads/${branch}`, object: { sha: "0".repeat(40) } })),
  );
}

function issueAuthorMatches(author: MockAuthor, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  // Real gh: `--author app/renovate` matches nothing for issues.
  const bot = author.login.startsWith("app/") ? `${author.login.slice(4)}[bot]` : author.login;
  return filter === bot;
}

function pullAuthorMatches(author: MockAuthor, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const bot = author.login.startsWith("app/") ? `${author.login.slice(4)}[bot]` : author.login;
  return filter === author.login || filter === bot;
}

function listing(
  state: MockState,
  command: string[],
  parsed: Parsed,
  group: "issue" | "pr",
): CommandResult {
  const name = flag(parsed, "-R", "--repo");
  const repository = repositoryState(state, name);
  if (!repository) {
    return fail(command, `GraphQL: Could not resolve to a Repository with the name '${name}'.\n`);
  }
  const target = group === "issue" ? "issues" : "pulls";
  const reason = failing(repository, target) ?? failing(repository, "repo");
  if (reason) return fail(command, reason);
  const fields = flag(parsed, "--json");
  if (!fields) return fail(command, "mock: only --json output is supported\n");
  const action = parsed.positionals[1];
  const stateFilter = (flag(parsed, "-s", "--state") ?? "open").toLowerCase();
  const items: Array<Record<string, unknown>> = (
    group === "issue"
      ? (repository.issues ?? []).map((issue) => ({
          url: `https://github.com/${name}/issues/${issue.number}`,
          ...issue,
        }))
      : (repository.pulls ?? []).map((pull) => ({
          url: `https://github.com/${name}/pull/${pull.number}`,
          author: RENOVATE_BOT,
          isDraft: false,
          ...pull,
        }))
  ).map((item) => ({ ...item, state: "OPEN" }));
  if (action === "view") {
    const number = Number(parsed.positionals[2]);
    const item = items.find((entry) => entry.number === number);
    if (!item) return fail(command, `GraphQL: Could not resolve to an issue or pull request.\n`);
    return ok(command, project(item, fields));
  }
  if (action !== "list") return fail(command, `mock: unsupported gh ${group} ${action}\n`);
  if (stateFilter !== "open" && stateFilter !== "all") return ok(command, []);
  const author = flag(parsed, "-A", "--author");
  const app = flag(parsed, "--app");
  const search = flag(parsed, "-S", "--search");
  const limit = Number(flag(parsed, "-L", "--limit") ?? 30);
  const selected = items
    .filter((item) =>
      group === "issue"
        ? issueAuthorMatches(item.author as MockAuthor, author)
        : pullAuthorMatches(item.author as MockAuthor, author),
    )
    .filter((item) => app === undefined || (item.author as MockAuthor).login === `app/${app}`)
    .filter(
      (item) =>
        search === undefined ||
        !/dependency dashboard/i.test(search) ||
        /dependency dashboard/i.test(String(item.title)),
    )
    .toSorted((left, right) => Number(right.number) - Number(left.number))
    .slice(0, limit);
  return ok(
    command,
    selected.map((item) => project(item, fields)),
  );
}

export type MockGithub = {
  calls: string[][];
  run: (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;
};

export function handleGh(state: MockState, args: string[]): CommandResult {
  const command = ["gh", ...args];
  const parsed = parse(args);
  const [group, action] = parsed.positionals;
  if (!isReadOnlyCall(command)) return fail(command, "mock: write calls are forbidden\n");
  if (group === "api") return api(state, command, parsed);
  if (group === "issue" || group === "pr") return listing(state, command, parsed, group);
  if (group === "repo" && action === "view") {
    const name = parsed.positionals[2] ?? flag(parsed, "-R", "--repo");
    const repository = repositoryState(state, name);
    if (!repository) return fail(command, "GraphQL: Could not resolve to a Repository\n");
    const reason = failing(repository, "repo");
    if (reason) return fail(command, reason);
    return ok(
      command,
      project(
        { nameWithOwner: name, defaultBranchRef: { name: "main" }, isArchived: false },
        flag(parsed, "--json"),
      ),
    );
  }
  return fail(command, `mock: unsupported gh call ${args.join(" ")}\n`);
}

/** In-process runner with the `Runner` signature used by src/ (see open-pr-reconciliation.ts). */
export function mockGithub(state: MockState): MockGithub {
  const calls: string[][] = [];
  return {
    calls,
    run(command, args = [], cwd) {
      calls.push([command, ...args]);
      if (command === "gh") return handleGh(state, args);
      if (command === "git" && isReadOnlyCall([command, ...args])) {
        const result = spawnSync(command, args, { cwd, encoding: "utf8" });
        return {
          command: [command, ...args],
          status: result.status ?? 127,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }
      return fail([command, ...args], `mock: command ${command} is not allowed\n`);
    },
  };
}
