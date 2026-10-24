import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scopeNormalizers } from "../src/normalization-selection.ts";
import { normalizeRepository, type Normalizer } from "../src/normalization.ts";
import type { CommandResult } from "../src/shared.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function packageRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-normalization-selection-"));
  roots.push(root);
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      scripts: {
        "format:check": "oxfmt --check .",
        "format:write": "oxfmt .",
        lint: "oxlint .",
        "lint:fix": "oxlint --fix .",
      },
    }),
  );
  write(root, "bun.lock", "");
  write(root, ".gitignore", "node_modules\n");
  write(root, "node_modules/.bin/oxfmt", "");
  write(root, "node_modules/.bin/oxlint", "");
  write(root, "src/a.ts", "export const a=1\n");
  write(root, "src/b.ts", "export const b=1\n");
  write(root, "README.md", "# fixture\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

function recorder(): {
  commands: string[][];
  execute: (root: string, normalizer: Normalizer) => CommandResult;
} {
  const commands: string[][] = [];
  return {
    commands,
    execute: (_root, normalizer) => {
      commands.push(normalizer.command);
      return { command: normalizer.command, status: 0, stdout: "", stderr: "" };
    },
  };
}

test("scopes package oxlint and oxfmt adapters to explicit paths", () => {
  const root = packageRepository();
  const { commands, execute } = recorder();

  const result = normalizeRepository(
    root,
    { execute },
    { mode: "paths", paths: ["src/a.ts", "README.md", "../outside.ts"], cwd: root },
  );

  expect(result.status).toBe("passed");
  const bin = join(root, "node_modules", ".bin");
  expect(commands.slice(0, 2)).toEqual([
    [join(bin, "oxlint"), "--fix", "src/a.ts"],
    [join(bin, "oxfmt"), "README.md", "src/a.ts"],
  ]);
  expect(result.data.selection).toMatchObject({
    mode: "paths",
    files: ["README.md", "src/a.ts"],
    ignored: ["../outside.ts"],
  });
});

test("keeps composed convention flags when scoping a package script", () => {
  const root = packageRepository();
  const normalizer: Normalizer = {
    id: ".:format:check:oxfmt",
    ruleId: "normalizer.oxfmt",
    mode: "apply",
    component: "fixture",
    path: ".",
    capability: "format:check",
    tool: "oxfmt",
    command: ["bun", "run", "format:write", "--config", "conv.json", "--disable-nested-config"],
  };
  const { scoped } = scopeNormalizers(root, [normalizer], ["src/a.ts"]);

  expect(scoped[0].command).toEqual([
    join(root, "node_modules", ".bin", "oxfmt"),
    "--config",
    "conv.json",
    "--disable-nested-config",
    "src/a.ts",
  ]);
});

test("normalizes and re-stages only fully staged files", () => {
  const root = packageRepository();
  write(root, "src/a.ts", "export const a=2\n");
  write(root, "src/b.ts", "export const b=2\n");
  git(root, "add", "src/a.ts", "src/b.ts");
  write(root, "src/b.ts", "export const b=3\n");
  const commands: string[][] = [];

  const result = normalizeRepository(
    root,
    {
      execute: (_root, normalizer) => {
        commands.push(normalizer.command);
        write(root, "src/a.ts", "export const a = 2;\n");
        return { command: normalizer.command, status: 0, stdout: "", stderr: "" };
      },
    },
    { mode: "staged" },
  );

  expect(result.status).toBe("passed");
  expect(commands.every((command) => command.at(-1) === "src/a.ts")).toBe(true);
  expect(result.data).toMatchObject({
    selection: { files: ["src/a.ts"], partiallyStaged: ["src/b.ts"] },
    restaged: ["src/a.ts"],
  });
  expect(git(root, "show", ":src/a.ts")).toBe("export const a = 2;\n");
  expect(git(root, "show", ":src/b.ts")).toBe("export const b=2\n");
});

function rustWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-normalization-selection-"));
  roots.push(root);
  // The edition lives only in the member crate, as in most workspaces.
  write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/core"]\nresolver = "3"\n');
  write(
    root,
    "crates/core/Cargo.toml",
    '[package]\nname = "core-fixture"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  write(root, "crates/core/src/lib.rs", "pub mod extra;\n");
  write(root, "crates/core/src/extra.rs", "pub fn value() -> u8 {\n    1\n}\n");
  // Data fragment cargo never compiles; rustfmt on it would fail or rewrite it.
  write(root, "crates/core/assets/props.rs", "[1,2]\n");
  write(root, ".gitignore", "target\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

test("formats changed Rust with the repository's own cargo fmt, not bare rustfmt", () => {
  const root = rustWorkspace();
  write(root, "crates/core/src/lib.rs", "pub mod extra;\npub mod fresh;\n");
  write(root, "crates/core/src/fresh.rs", "pub fn fresh()->u8{2}\n");
  const { commands, execute } = recorder();

  const result = normalizeRepository(root, { execute }, { mode: "changed" });

  expect(result.status).toBe("passed");
  expect(commands[0]).toEqual(["cargo", "fmt", "--all"]);
  expect(result.data.selection).toMatchObject({ mode: "changed", base: "HEAD" });
});

const hasCargoFmt = spawnSync("cargo", ["fmt", "--version"]).status === 0;

test.skipIf(!hasCargoFmt)(
  "leaves cargo fmt --check clean for a member crate's style edition",
  () => {
    const root = rustWorkspace();
    // Style edition 2024 sorts `Value` before `json`; 2015/2021 sorts `json` first.
    write(
      root,
      "crates/core/src/extra.rs",
      "use std::collections::{hash_map, HashMap};\npub fn value()->u8{let _: Option<HashMap<u8, u8>> = None; let _ = hash_map::RandomState::new; 1}\n",
    );

    const result = normalizeRepository(
      root,
      {},
      {
        mode: "paths",
        paths: ["crates/core/src/extra.rs", "crates/core/assets/props.rs"],
        cwd: root,
      },
    );

    expect(result.status).toBe("passed");
    expect(spawnSync("cargo", ["fmt", "--all", "--check"], { cwd: root }).status).toBe(0);
    expect(git(root, "status", "--short", "--", "crates/core/assets")).toBe("");
  },
  120_000,
);

test("never formats files outside the package script's own path targets", () => {
  const root = packageRepository();
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      scripts: {
        "format:check": "oxfmt --check src vite.config.ts",
        format: "oxfmt src vite.config.ts",
        lint: "oxlint src/**/*.ts",
        "lint:fix": "oxlint --fix src/**/*.ts",
      },
    }),
  );
  write(root, "scripts/proof.mjs", "export {}\n");
  write(root, "public/site.css", "a{}\n");
  write(root, "vite.config.ts", "export default {}\n");
  const { commands, execute } = recorder();

  const result = normalizeRepository(
    root,
    { execute },
    {
      mode: "paths",
      paths: ["src/a.ts", "scripts/proof.mjs", "public/site.css", "vite.config.ts"],
      cwd: root,
    },
  );

  expect(result.status).toBe("passed");
  const bin = join(root, "node_modules", ".bin");
  expect(commands.slice(0, 2)).toEqual([
    [join(bin, "oxlint"), "--fix", "src/a.ts"],
    [join(bin, "oxfmt"), "src/a.ts", "vite.config.ts"],
  ]);
});

test("skips a package formatter when no selected file is in its targets", () => {
  const root = packageRepository();
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      scripts: { "format:check": "oxfmt --check src", format: "oxfmt src" },
    }),
  );
  const { commands, execute } = recorder();

  normalizeRepository(root, { execute }, { mode: "paths", paths: ["README.md"], cwd: root });

  expect(commands).toEqual([]);
});

test("skips adapters with no selected file of their kind", () => {
  const root = packageRepository();
  const { commands, execute } = recorder();

  const result = normalizeRepository(
    root,
    { execute },
    { mode: "paths", paths: ["README.md"], cwd: root },
  );

  expect(result.status).toBe("passed");
  expect(commands.map((command) => command[0])).toEqual([
    join(root, "node_modules", ".bin", "oxfmt"),
    join(root, "node_modules", ".bin", "oxfmt"),
  ]);
});
