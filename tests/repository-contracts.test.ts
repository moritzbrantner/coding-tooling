import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forbiddenAuthorityClaims,
  parseRepositoryContractDeclarations,
} from "../src/repository-contract-declarations.ts";
import {
  fleetRepositoryContracts,
  repositoryContractCommand,
} from "../src/repository-contract-verification.ts";
import { readRepositoryMetadata } from "../src/repository-metadata.ts";
import { runCommand } from "../src/shared.ts";
import type { Diagnostic } from "../src/model.ts";
import { taskPacketCommand, TASK_PACKET_VERSION } from "../src/agent-work.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fleet(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-contract-test-"));
  roots.push(root);
  return root;
}

function script(source: string): string[] {
  return [process.execPath, "-e", source];
}
const prepare = script(
  "const fs=require('node:fs');fs.mkdirSync('.artifacts',{recursive:true});fs.writeFileSync('.artifacts/ready','ready')",
);
const ready = script(
  "if(require('node:fs').readFileSync('.artifacts/ready','utf8')!=='ready')process.exit(1)",
);
const build = script(
  "const fs=require('node:fs');fs.readFileSync('.artifacts/ready');fs.writeFileSync('.artifacts/index.html','<title>Owned page</title>')",
);
const accept = script(
  "if(!require('node:fs').readFileSync('.artifacts/index.html','utf8').includes('<title>Owned page</title>'))process.exit(1)",
);

function repository(
  root: string,
  name: string,
  options: {
    owns?: string[];
    consumes?: string[];
    excludes?: string[];
    bootstrap?: string[] | false;
    pages?: string[] | false;
  } = {},
): string {
  const path = join(root, name);
  mkdirSync(path);
  expect(runCommand("git", ["init", "--quiet"], path).status).toBe(0);
  writeFileSync(join(path, ".gitignore"), ".artifacts/\n");
  writeFileSync(
    join(path, ".repository.toml"),
    [
      "schema_version = 1",
      `id = "example/${name}"`,
      'kind = "library"',
      'status = "active"',
      'summary = "Owns one explicit reusable capability."',
      "depends_on = []",
      "consumed_by = []",
      "supersedes = []",
      "replaced_by = []",
      "[architecture]",
      `owns = ${JSON.stringify(options.owns ?? [`${name}/runtime`])}`,
      `consumes = ${JSON.stringify(options.consumes ?? [])}`,
      `must_not_own = ${JSON.stringify(options.excludes ?? [])}`,
      ...(options.bootstrap === false
        ? []
        : [
            "[bootstrap]",
            `command = ${JSON.stringify(options.bootstrap ?? prepare)}`,
            `check = ${JSON.stringify(ready)}`,
            "timeout_seconds = 10",
          ]),
      ...(options.pages === false
        ? ["[pages]", 'status = "not-applicable"', 'reason = "Library has no static product."']
        : [
            "[pages]",
            'status = "enabled"',
            `command = ${JSON.stringify(options.pages ?? build)}`,
            `check = ${JSON.stringify(accept)}`,
            "timeout_seconds = 10",
          ]),
      "",
    ].join("\n"),
  );
  commit(path);
  return path;
}

function commit(root: string): void {
  expect(runCommand("git", ["add", "."], root).status).toBe(0);
  expect(
    runCommand(
      "git",
      [
        "-c",
        "user.name=Contract Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      root,
    ).status,
  ).toBe(0);
}

test("keeps legacy metadata readable while missing bootstrap remains an adoption gap", () => {
  const root = repository(fleet(), "foundation", { bootstrap: false, pages: false });
  expect(readRepositoryMetadata(root).metadata?.id).toBe("example/foundation");
  const result = repositoryContractCommand(root);
  expect(result.status).toBe("unavailable");
  expect(result.data.missingDeclarations).toEqual(["bootstrap"]);
  expect(result.data.bootstrap).toMatchObject({ status: "missing" });
  expect(result.data.pages).toMatchObject({ status: "not-applicable" });
});

test("declarations remain not-run until a clean checkout actually executes", () => {
  const root = repository(fleet(), "foundation");
  const result = repositoryContractCommand(root);
  expect(result.status).toBe("passed");
  expect(result.data.bootstrap).toMatchObject({ status: "not-run" });
  expect(result.data.pages).toMatchObject({ status: "not-run" });
  expect(existsSync(join(root, ".artifacts/ready"))).toBe(false);
});

test("verifies bootstrap and exact Pages acceptance in a removed clean checkout", () => {
  const root = repository(fleet(), "product");
  const sha = runCommand("git", ["rev-parse", "HEAD"], root).stdout.trim();
  const result = repositoryContractCommand(root, { execute: true });
  expect(result.status).toBe("passed");
  expect(result.data.bootstrap).toMatchObject({
    status: "passed",
    commands: [
      { phase: "command", argv: prepare, exitCode: 0 },
      { phase: "check", argv: ready, exitCode: 0 },
    ],
  });
  expect(result.data.pages).toMatchObject({
    status: "passed",
    commands: [
      { phase: "command", argv: build },
      { phase: "check", argv: accept },
    ],
  });
  const provenance = result.data.provenance as {
    revision: string;
    checkoutRoot: string;
    checkoutRemoved: boolean;
  };
  expect(provenance.revision).toBe(sha);
  expect(provenance.checkoutRemoved).toBe(true);
  expect(existsSync(provenance.checkoutRoot)).toBe(false);
  expect(existsSync(join(root, ".artifacts"))).toBe(false);
});

test("does not borrow undeclared sibling state from the original checkout", () => {
  const parent = fleet();
  writeFileSync(join(parent, "support.txt"), "hidden dependency");
  const root = repository(parent, "consumer", {
    bootstrap: script("require('node:fs').readFileSync('../support.txt')"),
  });
  const result = repositoryContractCommand(root, { execute: true });
  expect(result.status).toBe("failed");
  expect(result.data.bootstrap).toMatchObject({
    status: "failed",
    commands: [{ phase: "command", exitCode: 1 }],
  });
  expect(result.data.pages).toMatchObject({ status: "blocked" });
});

test("rejects dirty source and source-writing acceptance instead of verifying a different tree", () => {
  const root = repository(fleet(), "consumer", {
    pages: script(
      "require('node:fs').writeFileSync('invented-source.ts','export const value = true')",
    ),
  });
  appendFileSync(join(root, ".repository.toml"), "\n# uncommitted\n");
  const dirty = repositoryContractCommand(root, { execute: true });
  expect(dirty.status).toBe("unavailable");
  expect(dirty.data.bootstrap).toMatchObject({ status: "unavailable" });
  commit(root);
  const mutation = repositoryContractCommand(root, { execute: true });
  expect(mutation.status).toBe("failed");
  expect(mutation.data.pages).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("unignored"),
  });
  expect(existsSync(join(root, "invented-source.ts"))).toBe(false);
});

test("keeps bootstrap failures and Pages failures separate and stops on the first failure", () => {
  const parent = fleet();
  repository(parent, "bootstrap-failure", { bootstrap: script("process.exit(7)") });
  repository(parent, "pages-failure", { pages: script("process.exit(8)") });
  const result = fleetRepositoryContracts(parent, { execute: true });
  expect(result.status).toBe("failed");
  expect(result.data.bootstrapFailures).toEqual(["example/bootstrap-failure"]);
  expect(result.data.pagesFailures).toEqual(["example/pages-failure"]);
});

test("enforces competing owners and explicit exclusions while permitting adapters", () => {
  const parent = fleet();
  repository(parent, "foundation", { owns: ["foundation/runtime"], pages: false });
  repository(parent, "capability", {
    owns: ["media/asr"],
    consumes: ["foundation/runtime"],
    pages: false,
  });
  repository(parent, "corpus", {
    owns: ["corpus/records"],
    consumes: ["media/asr"],
    excludes: ["media/asr"],
    pages: false,
  });
  repository(parent, "interpretation", {
    owns: ["interpretation/claims"],
    consumes: ["corpus/records"],
    excludes: ["media/asr"],
    pages: false,
  });
  const valid = fleetRepositoryContracts(parent);
  expect(valid.status).toBe("passed");
  expect(valid.data.ownershipConflicts).toEqual([]);
  const rival = repository(parent, "rival", { owns: ["media/asr"], pages: false });
  expect(fleetRepositoryContracts(parent).data.ownershipConflicts).toEqual([
    { capability: "media/asr", repositories: ["example/capability", "example/rival"] },
  ]);
  appendFileSync(join(rival, ".repository.toml"), "\n");
  writeFileSync(
    join(rival, ".repository.toml"),
    readFileSync(join(rival, ".repository.toml"), "utf8").replace(
      "must_not_own = []",
      'must_not_own = ["media"]',
    ),
  );
  expect(repositoryContractCommand(rival).diagnostics).toContainEqual(
    expect.objectContaining({ code: "repository-forbidden-authority" }),
  );
  expect(
    forbiddenAuthorityClaims({ owns: [], consumes: ["media/asr"], mustNotOwn: ["media"] }, [
      "media/asr/native",
      "media-archive",
    ]),
  ).toEqual([{ capability: "media/asr/native", exclusion: "media" }]);
});

test("fails closed on unsupported declarations and conflicting local agent ownership", () => {
  const diagnostics: Diagnostic[] = [];
  parseRepositoryContractDeclarations(
    '[pages]\nstatus="not-applicable"\nreason="library"\ncommand=["echo"]\n',
    diagnostics,
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "repository-contract-declaration-invalid" }),
  );
  const root = repository(fleet(), "consumer", { pages: false });
  writeFileSync(join(root, "AGENTS.md"), "## Authority boundaries\n- Owns: `other/runtime`\n");
  expect(repositoryContractCommand(root).diagnostics).toContainEqual(
    expect.objectContaining({ code: "repository-authority-declaration-drift" }),
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "## Authority boundaries\n- Owns: `consumer/runtime`\n- Non-authoritative: `consumer`\n",
  );
  expect(repositoryContractCommand(root).diagnostics).toContainEqual(
    expect.objectContaining({ code: "repository-forbidden-authority" }),
  );
});

function sourceDependency(root: string, revision: string, localPath?: string): void {
  writeFileSync(
    join(root, ".coding-tooling.source-deps.json"),
    JSON.stringify({
      schemaVersion: 2,
      cargo: {
        localOnly: localPath !== undefined,
        patches: [
          {
            package: "source",
            git: "https://github.com/example/source.git",
            rev: revision,
            ...(localPath ? { localPath } : {}),
          },
        ],
      },
    }),
  );
  commit(root);
}

test("preserves exact source requirements and rejects conflicting fleet revisions", () => {
  const parent = fleet();
  const left = repository(parent, "left", { pages: false });
  const right = repository(parent, "right", { pages: false });
  const a = "1".repeat(40),
    b = "2".repeat(40);
  sourceDependency(left, a);
  sourceDependency(right, b);
  const result = fleetRepositoryContracts(parent);
  expect(result.status).toBe("failed");
  expect(result.data.sourceRevisionConflicts).toEqual([
    { repository: "https://github.com/example/source", revisions: [a, b] },
  ]);
  expect(repositoryContractCommand(left).data.sourceDependencies).toMatchObject({
    data: { repositories: [{ declaredRevisions: [a] }] },
  });
});

test("does not borrow a pre-existing absolute source checkout during bootstrap", () => {
  const parent = fleet();
  const source = repository(parent, "source", { pages: false });
  const consumer = repository(parent, "consumer", { pages: false });
  const revision = runCommand("git", ["rev-parse", "HEAD"], source).stdout.trim();
  sourceDependency(consumer, revision, source);
  expect(repositoryContractCommand(consumer).data.sourceDependencies?.status).toBe("passed");
  const result = repositoryContractCommand(consumer, { execute: true });
  expect(result.status).toBe("failed");
  expect(result.data.bootstrap.status).toBe("failed");
  expect(result.data.sourceDependencies?.diagnostics).toContainEqual(
    expect.objectContaining({ code: "bootstrap-external-source-checkout" }),
  );
});

test("checks task-packet ownership against explicit repository exclusions before execution", () => {
  const root = repository(fleet(), "corpus", {
    consumes: ["media/asr"],
    excludes: ["media"],
    pages: false,
  });
  const path = join(root, "packet.json");
  const packet = {
    schemaVersion: TASK_PACKET_VERSION,
    goal: "Implement one bounded slice",
    baselineSha: "1".repeat(40),
    ownedCapability: "media/asr",
    mustPreserve: [],
    outOfScope: [],
    changeKinds: ["behavior"],
  };
  writeFileSync(path, JSON.stringify(packet));
  const denied = taskPacketCommand(root, path);
  expect(denied.status).toBe("failed");
  expect(denied.diagnostics).toContainEqual(
    expect.objectContaining({ code: "task-packet-forbidden-repository-authority" }),
  );
  writeFileSync(path, JSON.stringify({ ...packet, ownedCapability: "corpus/asr-adapter" }));
  const allowed = taskPacketCommand(root, path);
  expect(allowed.status).toBe("passed");
  expect(allowed.data.repositoryBoundaries).toMatchObject({
    architecture: { consumes: ["media/asr"], mustNotOwn: ["media"] },
  });
});

test("uses native TOML root fields and never drops invalid relationship entries", () => {
  const root = repository(fleet(), "consumer", { pages: false });
  const path = join(root, ".repository.toml");
  const canonical = readFileSync(path, "utf8");
  writeFileSync(
    path,
    canonical.replace('id = "example/consumer"', "id = 'example/consumer' # native TOML literal"),
  );
  expect(readRepositoryMetadata(root).metadata?.id).toBe("example/consumer");
  writeFileSync(
    path,
    canonical.replace("depends_on = []", 'depends_on = ["example/foundation", 42]'),
  );
  expect(readRepositoryMetadata(root).metadata).toBeUndefined();
});

test("refuses to treat execution flags with extra values as opt-in", async () => {
  const { routerMain } = await import("../src/router.ts");
  expect(routerMain(["repository", "contract", "--execute", "false"])).toBe(2);
  expect(routerMain(["fleet", "contracts", "surprise"])).toBe(2);
});

test("bounds hanging bootstrap commands and rejects revision-changing commands", () => {
  const root = repository(fleet(), "consumer", {
    bootstrap: script("setInterval(()=>{},100)"),
    pages: false,
  });
  const path = join(root, ".repository.toml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("timeout_seconds = 10", "timeout_seconds = 1"),
  );
  commit(root);
  const timeout = repositoryContractCommand(root, { execute: true });
  expect(timeout.data.bootstrap.status).toBe("unavailable");
  expect(timeout.data.bootstrap.commands[0]?.signal).toBeTruthy();
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      JSON.stringify(script("setInterval(()=>{},100)")),
      JSON.stringify(["git", "checkout", "HEAD~1"]),
    ),
  );
  commit(root);
  const moved = repositoryContractCommand(root, { execute: true });
  expect(moved.data.bootstrap).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("captured source revision"),
  });
});
