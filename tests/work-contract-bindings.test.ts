// Acceptance for #301: declarative Rust/TypeScript/public-surface bindings to work contracts.
//
// Independent acceptance, written before any implementation. Contract pinned here:
//
// Seam
// - `workContractBindings(root)` exported from `src/work-contract-bindings.ts` returns a shared
//   `ResultEnvelope` with `operation: "work-contract-bindings"` and
//   `data.schemaVersion: "coding-tooling/work-contract-bindings/v1"`.
// - CLI: `coding-tooling performance bindings --root <dir> --json`; exit 0 passed, 1 failed,
//   2 unavailable (shared envelope mapping).
// - The command is read-only and static: it never runs the `performance:work` collector or any
//   repository command. A binding is declaration provenance, not execution evidence.
//
// Binding sources, in the issue's preferred order (budgets stay only in .performance/contract.json)
// 1. `public-contract`: the existing v2 operation field `publicContract` names a discovered
//    public-contract surface id (e.g. OpenAPI `http-operation:GET:%2Fusers%2F%7Bid%7D`). No source
//    marker is needed.
// 2. `openapi-operation-id`: an OpenAPI `operationId` equal to a work-contract operation id binds
//    that operation to the discovered `http-operation` surface. OpenAPI operations whose
//    operationId names no work operation are ordinary endpoints and are not diagnosed.
// 3. `source-marker`: a comment line `@coding-tooling-work <operation-id>` (in `//`, `///`,
//    `/** ... */` or ` * ` comment form) immediately above the declaration it binds. The marker
//    carries only the kebab-case operation id; any further token (e.g. a budget) is malformed.
//    Markers are read from repository source, never from `node_modules/` or Rust `target/`.
//
// data.operations[] (contract order): `{ id, publicContract, surface, state, bindings }` where
// `state` is "bound" | "unbound" | "stale" | "mismatched", `surface` is the stable public surface id
// (or null), and each binding is `{ source, surface?, declaration?, path?, line? }`
// (`path` repository-relative POSIX, `line` = 1-based marker line). An operation with no binding is
// `unbound` and not an error (not every operation is an endpoint).
//
// Diagnostics (status `failed`, exact codes; message names the operation id and locations):
// - work-binding-duplicate: two source declarations (markers, or OpenAPI operationIds) bind one id;
// - work-binding-unknown:   a marker names an id the contract does not declare;
// - work-binding-stale:     `publicContract` names a surface that is no longer discovered;
// - work-binding-mismatch:  an owned declaration (OpenAPI operationId) binds the operation to a
//                           different surface than its declared `publicContract`;
// - work-binding-malformed: a marker without an id, with extra tokens, or not adjacent to code.
// A missing contract is `unavailable` with `performance-contract-missing` (as `performance work`).
//
// Executed work evidence (`performance work`, #300) is matched by work-contract operation id only:
// evidence keyed by a surface id or handler name cannot satisfy an operation, and evidence for one
// operation never satisfies another.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { workComplexityEvidence } from "../src/work-complexity.ts";

type Binding = {
  source: "public-contract" | "openapi-operation-id" | "source-marker";
  surface?: string;
  declaration?: string;
  path?: string;
  line?: number;
} & Record<string, unknown>;
type BindingOperation = {
  id: string;
  publicContract: string | null;
  surface: string | null;
  state: "bound" | "unbound" | "stale" | "mismatched";
  bindings: Binding[];
};
type BindingsEnvelope = {
  schemaVersion: 1;
  operation: string;
  status: "passed" | "failed" | "unavailable" | "error";
  data: {
    schemaVersion: string;
    operations: BindingOperation[];
    limitations: string[];
  } & Record<string, unknown>;
  diagnostics: { code?: string; message: string; path?: string }[];
};

// Loaded dynamically so the evidence-identity invariants below still run before the module exists.
const bindingsModule = resolve(import.meta.dir, "../src/work-contract-bindings.ts");
async function bindings(root: string): Promise<BindingsEnvelope> {
  const module = (await import(bindingsModule)) as {
    workContractBindings: (root: string) => BindingsEnvelope;
  };
  return module.workContractBindings(root);
}

const router = resolve(import.meta.dir, "../src/router.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const USERS_GET_SURFACE = "http-operation:GET:%2Fusers%2F%7Bid%7D";
const USERS_LIST_SURFACE = "http-operation:GET:%2Fusers";
const PROFILE_SURFACE = "http-operation:GET:%2Fusers%2F%7Bid%7D%2Fprofile";

function operation(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    description: `Work for ${id}.`,
    dimensions: { rows: { description: "stored rows" } },
    scalePoints: [{ rows: 1000 }, { rows: 10000 }],
    metrics: [
      {
        name: "rows_read",
        unit: "rows",
        signal: "operation-count",
        budget: { max: 8 },
        growth: [{ dimension: "rows", bound: "constant" }],
      },
    ],
    ...extra,
  };
}

function contract(operations: unknown[]) {
  return {
    schemaVersion: 2,
    suite: "fixture/bindings",
    scenarios: [
      {
        id: "common-work",
        kind: "common",
        description: "Representative deterministic fixture",
        dimensions: { rows: 1000 },
        metrics: [
          {
            name: "rows_read",
            unit: "rows",
            direction: "lower",
            signal: "operation-count",
            blocking: true,
            budget: { relativeRegressionPercent: 5 },
          },
        ],
      },
    ],
    operations,
  };
}

function openApi(paths: Record<string, Record<string, { operationId?: string }>>) {
  return { openapi: "3.1.0", info: { title: "fixture", version: "1.0.0" }, paths };
}

/** A temporary repository; `files` maps repository-relative paths to contents (objects as JSON). */
function repo(files: Record<string, unknown>, declared?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-work-bindings-"));
  roots.push(root);
  const all: Record<string, unknown> = { ...files };
  if (declared !== undefined) all[".performance/contract.json"] = declared;
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  return root;
}

function lineOf(content: string, needle: string, occurrence = 1): number {
  let seen = 0;
  for (const [index, line] of content.split("\n").entries())
    if (line.includes(needle) && ++seen === occurrence) return index + 1;
  throw new Error(`fixture does not contain ${needle}`);
}

function op(report: BindingsEnvelope, id: string): BindingOperation {
  const found = report.data.operations.find((value) => value.id === id);
  if (!found) throw new Error(`operation ${id} is missing from the binding report`);
  return found;
}

function diagnostic(report: BindingsEnvelope, code: string) {
  return report.diagnostics.filter((value) => value.code === code);
}

// Axum-style Rust endpoint; there is no Rust route inventory, so the marker is the binding.
const AXUM = `use axum::{extract::Path, routing::get, Json, Router};

pub struct User;

/// Fetch one user by id.
/// @coding-tooling-work users-get
async fn get_user(Path(id): Path<u64>) -> Json<User> {
    let _ = id;
    Json(User)
}

pub fn router() -> Router {
    Router::new().route("/users/:id", get(get_user))
}
`;

// TypeScript router endpoints (JSDoc and line-comment forms).
const TS_ROUTER = `import { Router } from "./router-lib";

const app = new Router();

/** @coding-tooling-work users-list */
app.get("/users", (_request, response) => response.json([]));

// @coding-tooling-work users-create
app.post("/users", (request, response) => response.json(request.body));

export default app;
`;

const RUST_PACKAGE = {
  "Cargo.toml": '[package]\nname = "fixture-api"\nversion = "0.1.0"\nedition = "2021"\n',
};
const TS_PACKAGE = { "package.json": { name: "fixture-api", private: true } };

describe("source-adjacent markers where no inventory exists", () => {
  test("an Axum-style Rust handler binds through its doc-comment marker with file/line provenance", async () => {
    const root = repo(
      { ...RUST_PACKAGE, "src/routes.rs": AXUM },
      contract([operation("users-get"), operation("cache-rebuild")]),
    );

    const report = await bindings(root);

    expect(report.schemaVersion).toBe(1);
    expect(report.operation).toBe("work-contract-bindings");
    expect(report.data.schemaVersion).toBe("coding-tooling/work-contract-bindings/v1");
    expect(report.status).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(op(report, "users-get")).toMatchObject({ state: "bound", surface: null });
    expect(op(report, "users-get").bindings).toEqual([
      expect.objectContaining({
        source: "source-marker",
        path: "src/routes.rs",
        line: lineOf(AXUM, "@coding-tooling-work users-get"),
      }),
    ]);
    // Not every work operation is an endpoint: an unbound operation is reported, not an error.
    expect(op(report, "cache-rebuild")).toMatchObject({ state: "unbound", bindings: [] });
  });

  test("TypeScript router endpoints bind through JSDoc and line-comment markers", async () => {
    const root = repo(
      { ...TS_PACKAGE, "src/server.ts": TS_ROUTER },
      contract([operation("users-list"), operation("users-create")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(op(report, "users-list")).toMatchObject({ state: "bound", surface: null });
    expect(op(report, "users-list").bindings).toEqual([
      expect.objectContaining({
        source: "source-marker",
        path: "src/server.ts",
        line: lineOf(TS_ROUTER, "@coding-tooling-work users-list"),
      }),
    ]);
    expect(op(report, "users-create").bindings).toEqual([
      expect.objectContaining({
        source: "source-marker",
        path: "src/server.ts",
        line: lineOf(TS_ROUTER, "@coding-tooling-work users-create"),
      }),
    ]);
  });

  test("marker-like lines inside TS template literals and Rust raw strings bind nothing", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        ...RUST_PACKAGE,
        "src/literals.ts": [
          "const example = `",
          "// @coding-tooling-work users-list",
          "export const fake = () => {};",
          "/** @coding-tooling-work users-list */",
          "export const anotherFake = () => {};",
          "`;",
          "/*",
          " * @coding-tooling-work users-real",
          " */",
          "export const actual = () => {};",
        ].join("\n"),
        "src/literals.rs": [
          'const EXAMPLE: &str = r###"',
          "/// @coding-tooling-work users-create",
          "fn fake() {}",
          '"###;',
        ].join("\n"),
      },
      contract([operation("users-list"), operation("users-create"), operation("users-real")]),
    );

    const report = await bindings(root);
    expect(report.status).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(op(report, "users-list").bindings).toEqual([]);
    expect(op(report, "users-create").bindings).toEqual([]);
    expect(op(report, "users-real").bindings).toEqual([
      expect.objectContaining({ source: "source-marker", path: "src/literals.ts", line: 8 }),
    ]);
  });
  test("markers in node_modules and Rust target output are not repository declarations", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        "src/server.ts": TS_ROUTER,
        "node_modules/dep/index.ts":
          "/** @coding-tooling-work users-list */\nexport const x = 1;\n",
        "target/debug/build/out.rs": "/// @coding-tooling-work users-list\nfn generated() {}\n",
      },
      contract([operation("users-list"), operation("users-create")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("passed");
    expect(diagnostic(report, "work-binding-duplicate")).toEqual([]);
    expect(op(report, "users-list").bindings).toHaveLength(1);
  });
});

describe("public-surface bindings without source markers", () => {
  test("publicContract binds an operation to a discovered OpenAPI surface", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        "openapi.json": openApi({ "/users/{id}": { get: {} }, "/users": { get: {} } }),
      },
      contract([operation("users-get", { publicContract: USERS_GET_SURFACE })]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(op(report, "users-get")).toMatchObject({
      state: "bound",
      publicContract: USERS_GET_SURFACE,
      surface: USERS_GET_SURFACE,
    });
    expect(op(report, "users-get").bindings).toEqual([
      expect.objectContaining({
        source: "public-contract",
        surface: USERS_GET_SURFACE,
        declaration: "openapi.json",
      }),
    ]);
  });

  test("an OpenAPI operationId equal to a work operation id binds it; unrelated operationIds are ignored", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        "openapi.json": openApi({
          "/users": { get: { operationId: "users-list" } },
          "/health": { get: { operationId: "health-check" } },
        }),
      },
      contract([operation("users-list")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("passed");
    expect(report.diagnostics).toEqual([]);
    expect(op(report, "users-list")).toMatchObject({
      state: "bound",
      surface: USERS_LIST_SURFACE,
    });
    expect(op(report, "users-list").bindings).toEqual([
      expect.objectContaining({
        source: "openapi-operation-id",
        surface: USERS_LIST_SURFACE,
        declaration: "openapi.json",
      }),
    ]);
  });

  test("a source marker never replaces the declared public surface identity", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        "openapi.json": openApi({ "/users/{id}": { get: {} }, "/users/{id}/profile": { get: {} } }),
        "src/profile.ts":
          'const app = { get: (..._args: unknown[]) => {} };\n/** @coding-tooling-work users-get */\napp.get("/users/:id/profile", () => {});\n',
      },
      contract([operation("users-get", { publicContract: USERS_GET_SURFACE })]),
    );

    const report = await bindings(root);

    expect(op(report, "users-get").surface).toBe(USERS_GET_SURFACE);
    expect(op(report, "users-get").bindings).toContainEqual(
      expect.objectContaining({ source: "public-contract", surface: USERS_GET_SURFACE }),
    );
    for (const binding of op(report, "users-get").bindings)
      expect(binding.surface === undefined || binding.surface === USERS_GET_SURFACE).toBe(true);
  });
});

describe("exact binding diagnostics", () => {
  test("two source markers for one operation id are a duplicate naming both locations", async () => {
    const second = "/** @coding-tooling-work users-get */\nexport const again = () => {};\n";
    const root = repo(
      { ...TS_PACKAGE, ...RUST_PACKAGE, "src/routes.rs": AXUM, "src/again.ts": second },
      contract([operation("users-get")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("failed");
    const duplicates = diagnostic(report, "work-binding-duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.message).toContain("users-get");
    expect(duplicates[0]!.message).toContain(
      `src/routes.rs:${lineOf(AXUM, "@coding-tooling-work users-get")}`,
    );
    expect(duplicates[0]!.message).toContain("src/again.ts:1");
  });

  test("two OpenAPI operations declaring the same operationId are a duplicate", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        "openapi.json": openApi({
          "/users": { get: { operationId: "users-list" } },
          "/users/{id}": { get: { operationId: "users-list" } },
        }),
      },
      contract([operation("users-list")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("failed");
    const duplicates = diagnostic(report, "work-binding-duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.message).toContain("users-list");
    expect(duplicates[0]!.message).toContain(USERS_LIST_SURFACE);
    expect(duplicates[0]!.message).toContain(USERS_GET_SURFACE);
  });

  test("a marker naming an undeclared operation id is unknown, with file and line", async () => {
    const source = `${TS_ROUTER}\n/** @coding-tooling-work users-delete */\nexport const remove = () => {};\n`;
    const root = repo(
      { ...TS_PACKAGE, "src/server.ts": source },
      contract([operation("users-list"), operation("users-create")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("failed");
    const unknown = diagnostic(report, "work-binding-unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.path).toBe("src/server.ts");
    expect(unknown[0]!.message).toContain("users-delete");
    expect(unknown[0]!.message).toContain(
      `src/server.ts:${lineOf(source, "@coding-tooling-work users-delete")}`,
    );
  });

  test("changing the route identity without updating publicContract leaves visible stale debt", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        // The route was renamed from /users/{id} to /accounts/{id}; the contract was not updated.
        "openapi.json": openApi({ "/accounts/{id}": { get: {} } }),
      },
      contract([operation("users-get", { publicContract: USERS_GET_SURFACE })]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("failed");
    expect(op(report, "users-get").state).toBe("stale");
    const stale = diagnostic(report, "work-binding-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.path).toBe(".performance/contract.json");
    expect(stale[0]!.message).toContain("users-get");
    expect(stale[0]!.message).toContain(USERS_GET_SURFACE);
  });

  test("an operationId on a different surface than the declared publicContract is a mismatch, not a silent rebind", async () => {
    const root = repo(
      {
        ...TS_PACKAGE,
        "openapi.json": openApi({
          "/users/{id}": { get: { operationId: "users-show" } },
          "/users/{id}/profile": { get: { operationId: "users-get" } },
        }),
      },
      contract([operation("users-get", { publicContract: USERS_GET_SURFACE })]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("failed");
    expect(op(report, "users-get")).toMatchObject({
      state: "mismatched",
      surface: USERS_GET_SURFACE,
    });
    const mismatch = diagnostic(report, "work-binding-mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.message).toContain("users-get");
    expect(mismatch[0]!.message).toContain(USERS_GET_SURFACE);
    expect(mismatch[0]!.message).toContain(PROFILE_SURFACE);
  });

  test("markers without an id, carrying a budget, or detached from code are malformed", async () => {
    const source = [
      "/** @coding-tooling-work */",
      "export const missingId = () => {};",
      "// @coding-tooling-work users-list max=4",
      "export const withBudget = () => {};",
      "// @coding-tooling-work users-list",
      "",
      "export const detached = () => {};",
      "",
    ].join("\n");
    const root = repo(
      { ...TS_PACKAGE, "src/markers.ts": source },
      contract([operation("users-list")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("failed");
    const malformed = diagnostic(report, "work-binding-malformed");
    expect(malformed).toHaveLength(3);
    for (const value of malformed) expect(value.path).toBe("src/markers.ts");
    for (const line of [1, 3, 5])
      expect(malformed.some((value) => value.message.includes(`src/markers.ts:${line}`))).toBe(
        true,
      );
    // A malformed or detached marker binds nothing; the budget stays single-sourced in the contract.
    expect(op(report, "users-list")).toMatchObject({ state: "unbound", bindings: [] });
  });

  test("a missing performance contract is unavailable", async () => {
    const root = repo({ ...TS_PACKAGE, "src/server.ts": TS_ROUTER });

    const report = await bindings(root);

    expect(report.status).toBe("unavailable");
    expect(diagnostic(report, "performance-contract-missing")).toHaveLength(1);
  });
});

describe("provenance is not execution evidence", () => {
  test("binding discovery never runs the work collector and claims no execution", async () => {
    const root = repo(
      {
        "package.json": { name: "fixture-api", private: true },
        "src/server.ts": TS_ROUTER,
        "scripts/work.ts":
          'require("node:fs").writeFileSync("collector-ran", "yes");\nprocess.stdout.write("{}");\n',
        ".coding-tooling.json": {
          schemaVersion: 1,
          capabilityCommands: {
            ".": { "performance:work": [process.execPath, "scripts/work.ts"] },
          },
        },
      },
      contract([operation("users-list"), operation("users-create")]),
    );

    const report = await bindings(root);

    expect(report.status).toBe("passed");
    expect(existsSync(join(root, "collector-ran"))).toBe(false);
    expect(report.data.limitations.some((value) => /execut/i.test(value))).toBe(true);
    for (const operation of report.data.operations)
      for (const binding of operation.bindings)
        for (const key of ["executed", "verified", "outcome", "evidence", "samples"])
          expect(binding).not.toHaveProperty(key);
    // Budgets live only in the contract; the binding report does not restate them.
    expect(JSON.stringify(report.data)).not.toContain('"budget"');
  });
});

describe("executed work evidence is matched by the same operation id", () => {
  function workRepo(): string {
    return repo(
      {
        ...TS_PACKAGE,
        "openapi.json": openApi({ "/users/{id}": { get: {} }, "/users": { get: {} } }),
        "src/server.ts": TS_ROUTER,
      },
      contract([
        operation("users-get", { publicContract: USERS_GET_SURFACE }),
        operation("users-list"),
      ]),
    );
  }

  function writeEvidence(root: string, operations: { id: string }[]): string {
    const sha = createHash("sha256")
      .update(readFileSync(join(root, ".performance/contract.json")))
      .digest("hex");
    const samples = [1000, 10000].map((rows) => ({
      dimensions: { rows },
      metrics: { rows_read: 2 },
    }));
    const path = join(root, "evidence.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: "coding-tooling/work-evidence/v1",
        suite: "fixture/bindings",
        contractSha256: sha,
        operations: operations.map(({ id }) => ({ id, samples })),
      }),
    );
    return path;
  }

  test("passing evidence for one endpoint cannot satisfy another endpoint's contract", () => {
    const root = workRepo();
    const report = workComplexityEvidence(root, {
      evidence: writeEvidence(root, [{ id: "users-list" }]),
    });

    expect(report.status).toBe("unavailable");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "work-evidence-incomplete" }),
    );
    expect(report.diagnostics.map((value) => value.message).join("\n")).toContain("users-get");
  });

  test("evidence keyed by the public surface id or the handler name does not identify the operation", () => {
    for (const id of [USERS_GET_SURFACE, "get_user"]) {
      const root = workRepo();
      const report = workComplexityEvidence(root, {
        evidence: writeEvidence(root, [{ id }, { id: "users-list" }]),
      });

      expect(report.status).toBe("unavailable");
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: "work-evidence-mismatched" }),
      );
    }
  });
});

describe("CLI", () => {
  function cli(root: string) {
    return spawnSync(
      process.execPath,
      [router, "performance", "bindings", "--root", root, "--json"],
      {
        encoding: "utf8",
      },
    );
  }

  test("omitting --root uses cwd without invoking git", () => {
    const root = repo({ ...TS_PACKAGE, "src/server.ts": TS_ROUTER }, contract([operation("users-list")]));
    const env = { ...process.env };
    if (process.platform !== "win32") {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const git = join(bin, "git");
      writeFileSync(git, '#!/bin/sh\nprintf invoked > git-was-invoked\nexit 77\n');
      chmodSync(git, 0o755);
      env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
    }
    const result = spawnSync(process.execPath, [router, "performance", "bindings", "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.root).toBe(root);
    expect(existsSync(join(root, "git-was-invoked"))).toBe(false);
  });
  test("performance bindings prints a stable envelope and maps failures to exit codes", () => {
    const clean = repo(
      { ...TS_PACKAGE, "src/server.ts": TS_ROUTER },
      contract([operation("users-list"), operation("users-create")]),
    );
    const first = cli(clean);
    expect(first.status).toBe(0);
    const envelope = JSON.parse(first.stdout);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      operation: "work-contract-bindings",
      status: "passed",
      data: { schemaVersion: "coding-tooling/work-contract-bindings/v1" },
    });
    // Deterministic: a second run reports identical data and diagnostics.
    const second = JSON.parse(cli(clean).stdout);
    expect(second.data).toEqual(envelope.data);
    expect(second.diagnostics).toEqual(envelope.diagnostics);

    const broken = repo(
      { ...TS_PACKAGE, "src/server.ts": `${TS_ROUTER}// @coding-tooling-work nope\nexport {};\n` },
      contract([operation("users-list"), operation("users-create")]),
    );
    const failed = cli(broken);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).status).toBe("failed");

    const missing = repo({ ...TS_PACKAGE });
    expect(cli(missing).status).toBe(2);
  });
});
