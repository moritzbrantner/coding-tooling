// Acceptance for #313: Cargo source mode must patch git dependencies, not only crates-io.
//
// Pinned behaviour (independent acceptance, written before the implementation):
// - For a declared Cargo source package that the consumer depends on through a `git = "<url>"`
//   dependency (renamed with `package = ...` or not), the generated `.cargo/config.toml` patches
//   it under `[patch."<url as written by the consumer>"]` instead of `[patch.crates-io]`, matching
//   URLs canonically (a trailing `.git` or `/` does not matter). Other declared packages keep
//   `[patch.crates-io]`.
// - The declared source revision is the local-development revision; it may differ from the rev
//   the consumer pins (that is the point of testing an unpushed upstream change).
// - Activation verifies every generated patch is used by the consumer's crate graph; an unused
//   patch makes activation fail (status "error") and leaves no generated Cargo config behind.
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
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

import { renderSourceDependencies, sourceDependencies } from "../src/source-deps.ts";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function crate(root: string, name: string, body = "pub fn value() -> u32 { 1 }\n"): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n`,
  );
  writeFileSync(join(root, "src", "lib.rs"), body);
}

type Fixture = { workspace: string; consumer: string; source: string; url: string; rev: string };

function fixture(consumerUrl?: (url: string) => string): Fixture {
  // realpath: macOS tmpdir is a symlink, and cargo reports canonical manifest paths.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "coding-tooling-git-patches-")));
  const source = join(workspace, "source");
  const consumer = join(workspace, "consumer");
  mkdirSync(source, { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=main", source]).status).toBe(0);
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  writeFileSync(
    join(source, "Cargo.toml"),
    '[workspace]\nmembers = ["crates/core", "crates/unused"]\nresolver = "2"\n',
  );
  crate(join(source, "crates", "core"), "moenarch-text-core");
  crate(join(source, "crates", "unused"), "source-unused");
  git(source, "add", ".");
  git(source, "commit", "-m", "source");
  const rev = git(source, "rev-parse", "HEAD");
  const url = pathToFileURL(source).href;

  crate(consumer, "consumer", "pub use text_core::value;\n");
  writeFileSync(
    join(consumer, "Cargo.toml"),
    [
      "[package]",
      'name = "consumer"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      `text-core = { package = "moenarch-text-core", git = "${consumerUrl ? consumerUrl(url) : url}", rev = "${rev}" }`,
      "",
    ].join("\n"),
  );
  return { workspace, consumer, source, url, rev };
}

function declare(
  { consumer, url, rev }: Fixture,
  packages: Array<{ package: string; path: string }>,
  declaredUrl = url,
): void {
  writeFileSync(
    join(consumer, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        cargo: {
          localOnly: true,
          repositories: [{ git: declaredUrl, rev, localPath: "../source", packages }],
        },
      },
      null,
      2,
    )}\n`,
  );
}

const CORE = { package: "moenarch-text-core", path: "crates/core" };

function section(content: string, header: string): string {
  const start = content.indexOf(header);
  if (start < 0) return "";
  const rest = content.slice(start + header.length);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Cargo source mode for git dependencies (#313)", () => {
  test("a renamed git dependency is patched under its git source, not crates-io", () => {
    const setup = fixture();
    declare(setup, [CORE]);
    const rendered = renderSourceDependencies(setup.consumer);
    const gitSection = section(rendered.content, `[patch."${setup.url}"]`);
    expect(gitSection).toContain('"moenarch-text-core"');
    // Same TOML basic-string escaping the existing source-deps tests expect (portable to Windows).
    expect(gitSection).toContain(join(setup.source, "crates", "core").replaceAll("\\", "\\\\"));
    expect(section(rendered.content, "[patch.crates-io]")).not.toContain("moenarch-text-core");
  });

  test("URL spelling differences between consumer and declaration still match", () => {
    const setup = fixture((url) => `${url}.git`);
    declare(setup, [CORE], `${setup.url}/`);
    const rendered = renderSourceDependencies(setup.consumer);
    expect(section(rendered.content, `[patch."${setup.url}.git"]`)).toContain(
      '"moenarch-text-core"',
    );
  });

  test("activation makes cargo resolve the git dependency from the local checkout", () => {
    const setup = fixture();
    declare(setup, [CORE]);
    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status, JSON.stringify(activated.diagnostics)).toBe("passed");

    const metadata = spawnSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: setup.consumer,
      encoding: "utf8",
    });
    expect(metadata.status, metadata.stderr).toBe(0);
    expect(metadata.stderr).not.toContain("was not used in the crate graph");
    const core = (
      JSON.parse(metadata.stdout) as {
        packages: Array<{ name: string; source: string | null; manifest_path: string }>;
      }
    ).packages.find((entry) => entry.name === "moenarch-text-core");
    expect(core?.source).toBeNull();
    expect(core?.manifest_path).toBe(join(setup.source, "crates", "core", "Cargo.toml"));

    expect(sourceDependencies(setup.consumer, "deactivate").status).toBe("passed");
  });

  test("a declared revision ahead of the consumer's pin is the point of source mode", () => {
    const setup = fixture();
    writeFileSync(
      join(setup.source, "crates", "core", "src", "lib.rs"),
      "pub fn value() -> u32 { 2 }\n",
    );
    git(setup.source, "commit", "-am", "unpushed upstream change");
    const ahead = git(setup.source, "rev-parse", "HEAD");
    declare({ ...setup, rev: ahead }, [CORE]);
    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status, JSON.stringify(activated.diagnostics)).toBe("passed");
    sourceDependencies(setup.consumer, "deactivate");
  });

  test("an unused patch fails activation and leaves no generated config", () => {
    const setup = fixture();
    declare(setup, [CORE, { package: "source-unused", path: "crates/unused" }]);
    const activated = sourceDependencies(setup.consumer, "activate");
    expect(activated.status).toBe("error");
    expect(activated.diagnostics.map((value) => value.message).join("\n")).toContain(
      "source-unused",
    );
    const config = join(setup.consumer, ".cargo", "config.toml");
    expect(existsSync(config) ? readFileSync(config, "utf8") : "").not.toContain("source-unused");
  });
});
