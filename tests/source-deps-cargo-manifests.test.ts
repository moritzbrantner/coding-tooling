import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { renderSourceDependencies, sourceDependencies } from "../src/source-deps.ts";
import { cargoDependencyDeclarations } from "../src/source-deps-cargo.ts";

const URL = "https://github.com/example/nlp-stack";

function section(content: string, header: string): string {
  const start = content.indexOf(header);
  if (start < 0) return "";
  const rest = content.slice(start + header.length);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function source(workspace: string): string {
  const root = join(workspace, "source");
  mkdirSync(root, { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=main", root]).status).toBe(0);
  for (const args of [
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ])
    expect(spawnSync("git", ["-C", root, ...args]).status).toBe(0);
  writeFileSync(join(root, "README.md"), "source\n");
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "commit", "-m", "source"]).status).toBe(0);
  return spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function consumer(
  manifests: Record<string, string>,
  packages: string[],
  options: { localPath?: boolean } = {},
): string {
  const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-cargo-manifests-"));
  const root = join(workspace, "consumer");
  const rev = options.localPath === false ? "1".repeat(40) : source(workspace);
  for (const [path, content] of Object.entries(manifests)) write(join(root, path), content);
  writeFileSync(
    join(root, ".coding-tooling.source-deps.json"),
    JSON.stringify({
      schemaVersion: 3,
      cargo: {
        repositories: [
          {
            git: `${URL}.git`,
            rev,
            ...(options.localPath === false ? {} : { localPath: "../source" }),
            packages: packages.map((name) => ({ package: name })),
          },
        ],
      },
    }),
  );
  return root;
}

describe("Cargo manifest discovery for source patches (#313)", () => {
  test("reads workspace dependencies, globbed members, dev/build and target tables", () => {
    const root = consumer(
      {
        "Cargo.toml": [
          "[workspace]",
          'members = ["crates/*", "tools/cli"]',
          'exclude = ["crates/skipped"]',
          "",
          "[workspace.dependencies]",
          `text-core = { package = "moenarch-text-core", git = "${URL}", rev = "abc" }`,
          "",
        ].join("\n"),
        "crates/app/Cargo.toml": [
          "[package]",
          'name = "app"',
          "",
          "[dependencies]",
          "text-core = { workspace = true }",
          'serde = "1"',
          "",
          "[dev-dependencies]",
          `tokenizer = { git = "${URL}.git", branch = "main" }`,
          "",
          "[target.'cfg(unix)'.build-dependencies]",
          `build-helper = { package = "moenarch-build", git = "${URL}/" }`,
          "",
        ].join("\n"),
        "crates/skipped/Cargo.toml": `[package]\nname = "skipped"\n\n[dependencies]\nhidden = { git = "${URL}" }\n`,
        "tools/cli/Cargo.toml": `[package]\nname = "cli"\n\n[dependencies]\nmoenarch-text-core = "0.1"\n`,
      },
      [],
    );
    const declarations = cargoDependencyDeclarations(root);
    expect(declarations.manifests).toHaveLength(3);
    expect([...declarations.git.keys()].sort()).toEqual([
      "moenarch-build",
      "moenarch-text-core",
      "tokenizer",
    ]);
    expect([...(declarations.git.get("tokenizer") ?? [])]).toEqual([`${URL}.git`]);
    expect(declarations.git.has("hidden")).toBe(false);
    expect([...declarations.registry].sort()).toEqual(["moenarch-text-core", "serde"]);
  });

  test("groups patches per consumer URL spelling and keeps registry packages on crates-io", () => {
    const root = consumer(
      {
        "Cargo.toml": [
          "[package]",
          'name = "consumer"',
          "",
          "[dependencies]",
          `core = { package = "moenarch-text-core", git = "${URL}" }`,
          "",
          "[dev-dependencies]",
          `tokenizer = { git = "${URL}.git" }`,
          "",
          "[build-dependencies]",
          'plain = "1"',
          "",
        ].join("\n"),
      },
      ["moenarch-text-core", "plain", "tokenizer"],
    );
    const rendered = renderSourceDependencies(root);
    expect(section(rendered.content, `[patch."${URL}"]`)).toContain('"moenarch-text-core"');
    expect(section(rendered.content, `[patch."${URL}"]`)).not.toContain('"tokenizer"');
    expect(section(rendered.content, `[patch."${URL}.git"]`)).toContain('"tokenizer"');
    const cratesIo = section(rendered.content, "[patch.crates-io]");
    expect(cratesIo).toContain('"plain"');
    expect(cratesIo).not.toContain('"moenarch-text-core"');
    expect(rendered.patches.map((patch) => [patch.package, patch.sources])).toEqual([
      ["moenarch-text-core", [URL]],
      ["plain", ["crates-io"]],
      ["tokenizer", [`${URL}.git`]],
    ]);
  });

  test("a package taken both from git and the registry is patched in both sections", () => {
    const root = consumer(
      {
        "Cargo.toml": `[package]\nname = "consumer"\n\n[dependencies]\ncore = { package = "core", git = "${URL}" }\n\n[target.'cfg(windows)'.dependencies]\ncore-registry = { package = "core", version = "0.1" }\n`,
      },
      ["core"],
    );
    const rendered = renderSourceDependencies(root);
    expect(rendered.patches[0]?.sources).toEqual(["crates-io", URL]);
  });

  test("a git dependency without a local checkout fails instead of patching git with itself", () => {
    const root = consumer(
      {
        "Cargo.toml": `[package]\nname = "consumer"\n\n[dependencies]\ncore = { git = "${URL}" }\n`,
      },
      ["core"],
      { localPath: false },
    );
    const activated = sourceDependencies(root, "activate");
    expect(activated.status).toBe("error");
    expect(activated.diagnostics[0]?.message).toContain("local checkout is required");
  });
});
