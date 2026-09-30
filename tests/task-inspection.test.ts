import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { resolveConventions } from "../src/conventions.ts";
import { inspectTaskContext } from "../src/task-inspection.ts";
import { validateTaskKnowledge, type TaskKnowledge } from "../src/task-knowledge-declarations.ts";
import { runCommand, walkFiles } from "../src/shared.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "coding-tooling-task-lookup-"));
  roots.push(parent);
  const root = join(parent, "consumer");
  const policyRoot = join(parent, "policy");
  write(parent, "AGENTS.md", "# Shared safety boundary\n");
  write(
    root,
    "AGENTS.md",
    "# Authority and safety\nDo not redefine simulation rules.\nArbitrary prose mentions UI-002 without declaring an exception.\n",
  );
  write(root, "CLAUDE.md", "@AGENTS.md\n");
  write(
    root,
    "package.json",
    JSON.stringify({ name: "root", scripts: { build: "exit 23", "test:unit": "exit 23" } }),
  );
  write(root, "bun.lock", "lookup must never install this fixture\n");
  write(
    root,
    "src/view/package.json",
    JSON.stringify({ name: "view", scripts: { build: "exit 23", "test:unit": "exit 23" } }),
  );
  write(root, "src/view/AGENTS.md", "# Local view instructions\n");
  write(root, "src/view/view.ts", "export const presentation = true;\n");
  write(root, "src/protocol/AGENTS.md", "# Unrelated protocol instructions\n");
  write(root, "src/protocol/wire.ts", "export const wire = true;\n");
  write(root, "docs/presentation.md", "# Presentation adoption\n");
  write(root, "docs/protocol.md", "# Protocol contract\n");
  write(root, "examples/view.ts", "export const view = true;\n");
  write(
    root,
    ".repository.toml",
    'schema_version=1\nid="example/consumer"\nkind="library"\nstatus="active"\nsummary="Explicit fixture owner"\ndepends_on=["example/engine"]\n',
  );
  write(
    policyRoot,
    "README.md",
    "# Policy\n```md\n## UI-999 — Valid-looking fenced example\n```\n",
  );
  write(policyRoot, "principles/README.md", "## PRINCIPLE-001 — Shared principle\n");
  write(policyRoot, "conventions/security/README.md", "## SECURITY-001 — Always preserve safety\n");
  write(
    policyRoot,
    "conventions/ui/README.md",
    "## UI-001 — UI guidance\n## UI-002 — Another rule\n",
  );
  write(policyRoot, "technologies/typescript/README.md", "# TypeScript policy\n");
  write(
    policyRoot,
    "registry/registry.json",
    JSON.stringify({
      schemaVersion: 1,
      modules: { base: { sources: ["principles", "conventions"] } },
    }),
  );
  const knowledge: TaskKnowledge = {
    schemaVersion: 1,
    completion: { tier: "full" },
    exceptions: [{ ruleId: "UI-001", source: "AGENTS.md" }],
    scopes: [
      {
        id: "view",
        paths: ["src/view/**"],
        taskKinds: ["presentation"],
        instructions: ["docs/presentation.md"],
        conventionRefs: ["UI-001"],
        capabilities: ["test:unit"],
        owners: ["example/consumer"],
        examples: [{ path: "examples/view.ts", entrypoint: "@example/ui" }],
      },
      {
        id: "protocol",
        paths: ["src/protocol/**"],
        instructions: ["docs/protocol.md"],
        conventionRefs: ["UI-002"],
        capabilities: ["build"],
      },
    ],
  };
  function configure(value = knowledge): void {
    write(
      root,
      ".coding-tooling.json",
      JSON.stringify({
        schemaVersion: 1,
        tiers: { full: ["build", "test:unit"] },
        taskKnowledge: value,
      }),
    );
  }
  configure();
  const policyContext = resolveConventions({ root, conventionsRoot: policyRoot });
  expect(policyContext.status).toBe("passed");
  return { root, parent, policyRoot, knowledge, configure, policyContext };
}

test("presentation lookup preserves global boundaries without requiring unrelated documents", () => {
  const { root, policyContext } = fixture();
  const before = walkFiles(root, 16).map((path) => [path, readFileSync(path, "utf8")]);
  const result = inspectTaskContext(root, {
    targets: ["src/view/view.ts"],
    taskKind: "presentation",
    policyContext,
  });
  expect(result.status).toBe("passed");
  expect(result.data.taskContext).toMatchObject({
    status: "resolved",
    selection: {
      scopes: ["view"],
      conservative: false,
      components: [{ name: "view", path: "src/view" }],
    },
    boundaries: {
      instructions: ["../AGENTS.md", "AGENTS.md", "CLAUDE.md", "src/view/AGENTS.md"],
      metadataSource: ".repository.toml",
    },
    instructions: [{ path: "docs/presentation.md", status: "available" }],
    focusedCommands: [
      {
        component: "view",
        capability: "test:unit",
        command: ["bun", "run", "test:unit"],
        execution: "not-run",
      },
    ],
    completionGate: { tier: "full", capabilities: ["build", "test:unit"], execution: "not-run" },
    examples: [{ path: "examples/view.ts", entrypoint: "@example/ui", execution: "not-run" }],
    exceptions: [
      { ruleId: "UI-001", source: { path: "AGENTS.md" }, semantics: "explicit-reference-only" },
    ],
    policy: { reused: true },
    conventions: [{ id: "PRINCIPLE-001" }, { id: "SECURITY-001" }, { id: "UI-001" }],
    conventionModules: [{ id: "base", source: "registry/registry.json" }],
  });
  expect(JSON.stringify(result.data.taskContext)).not.toContain("docs/protocol.md");
  expect(JSON.stringify(result.data.taskContext)).not.toContain("src/protocol/AGENTS.md");
  expect(walkFiles(root, 16).map((path) => [path, readFileSync(path, "utf8")])).toEqual(before);
  expect(existsSync(join(root, ".artifacts"))).toBe(false);
});

test("cross-boundary selection retains owners, component checks and exact dependency declarations", () => {
  const data = fixture();
  data.knowledge.scopes[0]!.components = ["."];
  data.knowledge.scopes[0]!.owners = ["example/engine", "example/consumer"];
  data.configure();
  write(
    data.root,
    ".coding-tooling.source-deps.json",
    JSON.stringify({
      schemaVersion: 3,
      cargo: {
        repositories: [
          {
            git: "https://github.com/example/engine.git",
            rev: "a".repeat(40),
            packages: [{ package: "engine" }],
          },
        ],
      },
    }),
  );
  const result = inspectTaskContext(data.root, {
    targets: ["src/protocol/wire.ts", "src/view/view.ts"],
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("passed");
  expect(result.data.taskContext).toMatchObject({
    selection: { scopes: ["protocol", "view"], components: [{ path: "." }, { path: "src/view" }] },
    instructions: [{ path: "docs/presentation.md" }, { path: "docs/protocol.md" }],
    owners: [
      { id: "example/consumer", validation: "repository-completion-gate" },
      { id: "example/engine", validation: "external-validation-not-selected" },
    ],
    sourceDependencies: [{ revision: "a".repeat(40), verification: "not-run" }],
  });
});

test("valid-looking neighboring paths never masquerade as an explicitly declared scope", () => {
  const data = fixture();
  write(data.root, "src/view-lookalike/view.ts", "export {};\n");
  const result = inspectTaskContext(data.root, {
    targets: ["src/view-lookalike/view.ts"],
    taskKind: "presentation",
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("unavailable");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "task-relationship-undeclared" }),
  );
  expect(result.data.taskContext).toMatchObject({
    status: "partial",
    selection: { conservative: true },
    completionGate: { tier: "full" },
  });
});

test("missing links, fenced rule lookalikes, generators and unsupported targets remain explicit", () => {
  const data = fixture();
  data.knowledge.scopes[0]!.instructions = ["docs/missing.md"];
  data.knowledge.scopes[0]!.conventionRefs = ["UI-999"];
  data.knowledge.scopes[0]!.generators = ["missing-generator"];
  data.configure();
  const result = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("unavailable");
  for (const code of [
    "task-reference-unresolved",
    "task-convention-reference-unresolved",
    "task-generator-unresolved",
  ])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  const unsupported = inspectTaskContext(data.root, {
    targets: ["src/**", "missing.ts"],
    components: ["missing"],
    policyContext: data.policyContext,
  });
  for (const code of [
    "task-target-selection-unsupported",
    "task-target-unresolved",
    "task-component-unresolved",
  ])
    expect(unsupported.diagnostics).toContainEqual(expect.objectContaining({ code }));
  expect(unsupported.data.taskContext).toMatchObject({
    status: "partial",
    selection: { conservative: true },
    completionGate: { tier: "full" },
  });
});

test("shuffled declarations and selectors produce identical compact context", () => {
  const data = fixture();
  data.knowledge.scopes[0]!.examples!.push({
    path: "docs/presentation.md",
    entrypoint: "documented-demo",
  });
  data.knowledge.scopes[0]!.conventionRefs = ["UI-002", "UI-001"];
  data.configure();
  const first = inspectTaskContext(data.root, {
    targets: ["src/protocol/wire.ts", "src/view/view.ts"],
    policyContext: data.policyContext,
  });
  data.knowledge.scopes.reverse();
  data.knowledge.scopes[1]!.examples!.reverse();
  data.knowledge.scopes[1]!.conventionRefs!.reverse();
  data.configure();
  const second = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts", "src/protocol/wire.ts"],
    policyContext: data.policyContext,
  });
  expect(second.data).toEqual(first.data);
  expect(second.diagnostics).toEqual(first.diagnostics);
});

test("reuses a policy context and exposes its original provenance without resolving another source", () => {
  const data = fixture();
  const result = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: data.policyContext,
    conventionsRoot: join(data.parent, "missing-policy"),
    registryPath: join(data.parent, "missing-registry"),
  });
  expect(result.status).toBe("passed");
  expect(result.data.taskContext).toMatchObject({
    policy: {
      reused: true,
      sourceRoot: data.policyRoot,
      sourceRevision: data.policyContext.data.sourceRevision,
    },
  });
});

test("the installed inspection entrypoint supports literal scope and cached policy context", () => {
  const data = fixture();
  const contextPath = join(data.parent, "policy-context.json");
  writeFileSync(contextPath, JSON.stringify(data.policyContext));
  const result = runCommand(
    process.execPath,
    [
      join(import.meta.dir, "../src/router.ts"),
      "inspect",
      "--root",
      data.root,
      "--target",
      "src/view/view.ts",
      "--task-kind",
      "presentation",
      "--policy-context",
      contextPath,
      "--json",
    ],
    data.root,
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    operation: "inspect",
    data: {
      taskContext: {
        schemaVersion: "coding-tooling/task-context/v1",
        selection: { scopes: ["view"] },
        policy: { reused: true },
      },
    },
  });
});

test("rejects invalid local relationship metadata instead of silently dropping it", () => {
  for (const value of [
    {
      schemaVersion: 1,
      scopes: [
        { id: "duplicate", paths: ["src/**"] },
        { id: "duplicate", paths: ["docs/**"] },
      ],
    },
    { schemaVersion: 1, scopes: [{ id: "escape", paths: ["../outside/**"] }] },
    { schemaVersion: 1, scopes: [], completion: { tier: "full", command: ["echo"] } },
    {
      schemaVersion: 1,
      scopes: [{ id: "bad-command", paths: ["src/**"], capabilities: ["invented-capability"] }],
    },
  ])
    expect(() => validateTaskKnowledge(value)).toThrow("taskKnowledge");
});

test("routes to an existing generator and its rule without executing its template", () => {
  const data = fixture();
  const descriptor = {
    schemaVersion: 1,
    id: "view-example",
    description: "An existing fixture generator",
    rules: ["UI-002"],
    technologies: ["typescript"],
    inputs: { name: { type: "identifier", required: true } },
    target: { kind: "root" },
    operations: [
      { kind: "create-file", template: "templates/example.tmpl", path: "generated/{{name}}.ts" },
    ],
    compose: [],
    prerequisites: [],
    postconditions: ["build"],
  };
  write(
    data.root,
    ".coding-tooling/generators/view-example/generator.json",
    JSON.stringify(descriptor),
  );
  write(
    data.root,
    ".coding-tooling/generators/view-example/templates/example.tmpl",
    "export const value = '{{name}}';\n",
  );
  data.knowledge.scopes[0]!.generators = ["view-example"];
  data.configure();
  const result = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("passed");
  expect(result.data.taskContext).toMatchObject({
    generators: [
      {
        id: "view-example",
        source: "local",
        status: "available",
        command: ["coding-tooling", "generate", "describe", "view-example", "--json"],
      },
    ],
  });
  expect(JSON.stringify(result.data.taskContext)).toContain('"id":"UI-002"');
  expect(existsSync(join(data.root, "generated"))).toBe(false);
  const described = runCommand(
    process.execPath,
    [join(import.meta.dir, "../src/router.ts"), "generate", "describe", "view-example", "--json"],
    data.root,
  );
  expect(described.status).toBe(0);
  expect(JSON.parse(described.stdout)).toMatchObject({ status: "passed" });
});

test("componentless repositories expose declared commands without manufactured toolchains", () => {
  const data = fixture();
  rmSync(join(data.root, "package.json"));
  rmSync(join(data.root, "src/view/package.json"));
  write(
    data.root,
    ".coding-tooling.json",
    JSON.stringify({
      schemaVersion: 1,
      tiers: { full: ["test:unit"] },
      capabilityCommands: { ".": { "test:unit": ["bun", "test"] } },
      taskKnowledge: data.knowledge,
    }),
  );
  const result = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("passed");
  expect(result.data.components).toMatchObject([{ kind: "repository", technologies: [] }]);
  expect(result.data.taskContext).toMatchObject({
    focusedCommands: [{ path: ".", command: ["bun", "test"] }],
    completionGate: { tier: "full" },
  });
});

test("incompatible cached contexts and absent completion gates cannot become complete evidence", () => {
  const data = fixture();
  const unsupported = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: {
      ...data.policyContext,
      data: { ...data.policyContext.data, root: data.parent },
    },
  });
  expect(unsupported.status).toBe("unavailable");
  expect(unsupported.diagnostics).toContainEqual(
    expect.objectContaining({ code: "task-policy-context-unsupported" }),
  );
  delete data.knowledge.completion;
  data.configure();
  const missing = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: data.policyContext,
  });
  expect(missing.status).toBe("unavailable");
  expect(missing.data.taskContext).toMatchObject({
    status: "partial",
    completionGate: { tier: "full", selection: "conservative-fallback" },
  });
});

test("scope flags reject missing or extra values instead of silently inspecting a broader scope", () => {
  const data = fixture();
  for (const args of [
    ["--target"],
    ["--task-context", "false"],
    ["--unknown", "src/view/view.ts"],
  ]) {
    const result = runCommand(
      process.execPath,
      [join(import.meta.dir, "../src/router.ts"), "inspect", ...args, "--json"],
      data.root,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  }
});

test("reports bounded directory discovery while literal deep targets retain their ancestors", () => {
  const data = fixture();
  const directory = `src/view/${Array.from({ length: 18 }, (_, index) => `level${index}`).join("/")}`;
  write(data.root, `${directory}/AGENTS.md`, "# Deep local instructions\n");
  write(data.root, `${directory}/view.ts`, "export {};\n");
  const broad = inspectTaskContext(data.root, {
    targets: ["src/view"],
    policyContext: data.policyContext,
  });
  expect(broad.status).toBe("unavailable");
  expect(broad.diagnostics).toContainEqual(
    expect.objectContaining({ code: "task-instruction-discovery-bounded" }),
  );
  const literal = inspectTaskContext(data.root, {
    targets: [`${directory}/view.ts`],
    policyContext: data.policyContext,
  });
  expect(literal.status).toBe("passed");
  expect(JSON.stringify(literal.data.taskContext)).toContain(`${directory}/AGENTS.md`);
});

test("never uses an external symlink target as resolved repository scope", () => {
  const data = fixture();
  symlinkSync(
    data.policyRoot,
    join(data.root, "src/borrowed"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = inspectTaskContext(data.root, {
    targets: ["src/borrowed/README.md"],
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("unavailable");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "task-target-unresolved" }),
  );
  expect(result.data.taskContext).toMatchObject({ selection: { conservative: true } });
});

test("missing focused capabilities and command-declaration sources remain adoption gaps", () => {
  const data = fixture();
  data.knowledge.scopes[0]!.capabilities = ["benchmark:smoke", "test:unit"];
  data.knowledge.completion = { command: ["bun", "run", "verify"], source: "missing-package.json" };
  data.configure();
  const result = inspectTaskContext(data.root, {
    targets: ["src/view/view.ts"],
    policyContext: data.policyContext,
  });
  expect(result.status).toBe("unavailable");
  for (const code of ["task-focused-capability-unavailable", "task-reference-unresolved"])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  expect(result.data.taskContext).toMatchObject({
    completionGate: { kind: "command", execution: "not-run" },
  });
});
