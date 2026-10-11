import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

import { renderSourceDependencies, sourceDependencies } from "../src/source-deps.ts";
import {
  cargoDependencyDeclarations,
  globSegment,
  workspaceLockfile,
} from "../src/source-deps-cargo.ts";

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
          `orphan = { git = "${URL}" }`,
          'unused-registry = "1"',
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
    // Workspace entries count only when a member inherits them with `workspace = true`.
    expect(declarations.git.has("orphan")).toBe(false);
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

describe("Cargo workspace glob classes (#313 review)", () => {
  test("glob segments support character classes, ranges and negation", () => {
    expect(globSegment("[ab]*").test("alpha")).toBe(true);
    expect(globSegment("[ab]*").test("beta")).toBe(true);
    expect(globSegment("[ab]*").test("gamma")).toBe(false);
    expect(globSegment("crate-[0-9]").test("crate-7")).toBe(true);
    expect(globSegment("crate-[0-9]").test("crate-x")).toBe(false);
    expect(globSegment("[!x]*").test("xtask")).toBe(false);
    expect(globSegment("[!x]*").test("core")).toBe(true);
    expect(globSegment("[]]").test("]")).toBe(true);
    expect(globSegment("a[b").test("a[b")).toBe(true);
    expect(globSegment("a.b").test("axb")).toBe(false);
  });

  test("workspace members and exclude expand character classes", () => {
    const root = consumer(
      {
        "Cargo.toml": '[workspace]\nmembers = ["crates/[ab]*"]\nexclude = ["crates/[!a]*"]\n',
        "crates/alpha/Cargo.toml": `[package]\nname = "alpha"\n\n[dependencies]\nkept = { git = "${URL}" }\n`,
        "crates/beta/Cargo.toml": `[package]\nname = "beta"\n\n[dependencies]\nexcluded = { git = "${URL}" }\n`,
        "crates/gamma/Cargo.toml": `[package]\nname = "gamma"\n\n[dependencies]\nunmatched = { git = "${URL}" }\n`,
      },
      [],
    );
    expect([...cargoDependencyDeclarations(root).git.keys()]).toEqual(["kept"]);
  });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function crate(root: string, name: string): void {
  write(
    join(root, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`,
  );
  write(join(root, "src", "lib.rs"), "pub fn value() -> u32 { 1 }\n");
}

/** A consumer that is a member of an enclosing workspace and inherits a git dependency. */
function enclosingWorkspace(): { outer: string; consumer: string } {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "coding-tooling-enclosing-")));
  const source = join(workspace, "source");
  mkdirSync(source, { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=main", source]).status).toBe(0);
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  write(join(source, "Cargo.toml"), '[workspace]\nmembers = ["core", "unused"]\nresolver = "2"\n');
  crate(join(source, "core"), "moenarch-text-core");
  crate(join(source, "unused"), "source-unused");
  git(source, "add", ".");
  git(source, "commit", "-m", "source");
  const rev = git(source, "rev-parse", "HEAD");
  const url = pathToFileURL(source).href;

  const outer = join(workspace, "outer");
  const consumerRoot = join(outer, "consumer");
  write(
    join(outer, "Cargo.toml"),
    `[workspace]\nmembers = ["consumer"]\nresolver = "2"\n\n[workspace.dependencies]\ntext-core = { package = "moenarch-text-core", git = "${url}", rev = "${rev}" }\n`,
  );
  crate(consumerRoot, "consumer");
  write(
    join(consumerRoot, "Cargo.toml"),
    `[package]\nname = "consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntext-core = { workspace = true }\n`,
  );
  writeFileSync(
    join(consumerRoot, ".coding-tooling.source-deps.json"),
    JSON.stringify({
      schemaVersion: 3,
      cargo: {
        localOnly: true,
        repositories: [
          {
            git: url,
            rev,
            localPath: "../../source",
            packages: [{ package: "moenarch-text-core", path: "core" }],
          },
        ],
      },
    }),
  );
  return { outer, consumer: consumerRoot };
}

function comparable(path: string): string {
  const real = realpathSync.native(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function declareUnused(consumerRoot: string): void {
  const path = join(consumerRoot, ".coding-tooling.source-deps.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.cargo.repositories[0].packages.push({ package: "source-unused", path: "unused" });
  writeFileSync(path, JSON.stringify(config));
}

describe("activation leaves the enclosing workspace lockfile unchanged (#313 review)", () => {
  test("an inherited git dependency of an enclosing workspace is patched and verified", () => {
    const { outer, consumer: consumerRoot } = enclosingWorkspace();
    const lockfile = workspaceLockfile(consumerRoot);
    expect(basename(lockfile)).toBe("Cargo.lock");
    expect(comparable(dirname(lockfile))).toBe(comparable(outer));
    const rendered = renderSourceDependencies(consumerRoot);
    expect(rendered.patches[0]?.sources).toHaveLength(1);
    expect(rendered.patches[0]?.sources[0]).not.toBe("crates-io");

    const activated = sourceDependencies(consumerRoot, "activate");
    expect(activated.status, JSON.stringify(activated.diagnostics)).toBe("passed");
    expect(activated.data.cargoVerification).toBe("verified");
    expect(existsSync(join(outer, "Cargo.lock"))).toBe(false);
    expect(existsSync(join(consumerRoot, "Cargo.lock"))).toBe(false);
    sourceDependencies(consumerRoot, "deactivate");
  });

  test("an existing enclosing lockfile is restored after passing and failing verification", () => {
    const { outer, consumer: consumerRoot } = enclosingWorkspace();
    const generated = spawnSync("cargo", ["generate-lockfile"], { cwd: outer, encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    const lockfile = join(outer, "Cargo.lock");
    const before = readFileSync(lockfile, "utf8");

    const activated = sourceDependencies(consumerRoot, "activate");
    expect(activated.status, JSON.stringify(activated.diagnostics)).toBe("passed");
    expect(readFileSync(lockfile, "utf8")).toBe(before);
    sourceDependencies(consumerRoot, "deactivate");

    declareUnused(consumerRoot);
    const failed = sourceDependencies(consumerRoot, "activate");
    expect(failed.status).toBe("error");
    expect(failed.diagnostics.map((value) => value.message).join("\n")).toContain("source-unused");
    expect(readFileSync(lockfile, "utf8")).toBe(before);
    expect(existsSync(join(consumerRoot, ".cargo", "config.toml"))).toBe(false);
  });
});
