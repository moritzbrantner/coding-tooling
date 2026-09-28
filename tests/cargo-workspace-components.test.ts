import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { discoverComponents, planChecks } from "../src/core.ts";

function crate(root: string, path: string, name: string): void {
  const directory = join(root, path);
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(
    join(directory, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n`,
  );
  writeFileSync(join(directory, "src", "lib.rs"), "");
}

function workspace(manifest: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-cargo-workspace-"));
  writeFileSync(join(root, "Cargo.toml"), manifest);
  return root;
}

describe("Cargo workspace components", () => {
  test("a workspace root is one Rust component covering listed and globbed members", () => {
    const root = workspace(
      [
        "[workspace]",
        'members = ["backend", "crates/*"]',
        'exclude = ["crates/excluded"]',
        'default-members = ["backend"]',
        'resolver = "2"',
        "",
      ].join("\n"),
    );
    crate(root, "backend", "backend");
    crate(root, "crates/core", "core");
    crate(root, "crates/protocol", "protocol");
    crate(root, "crates/excluded", "excluded");
    crate(root, "tools/standalone", "standalone");

    const components = discoverComponents(root).filter((component) => component.kind === "rust");

    expect(components.map((component) => component.path)).toEqual([
      ".",
      "crates/excluded",
      "tools/standalone",
    ]);
    expect(components[0]?.capabilities).toEqual({
      "format:check": ["cargo", "fmt", "--all", "--check"],
      lint: [
        "cargo",
        "clippy",
        "--workspace",
        "--all-targets",
        "--all-features",
        "--",
        "-D",
        "warnings",
      ],
      build: ["cargo", "build", "--workspace", "--locked"],
      test: ["cargo", "test", "--workspace", "--locked"],
      "test:unit": ["cargo", "test", "--workspace", "--locked", "--lib"],
      "test:integration": ["cargo", "test", "--workspace", "--locked", "--tests"],
    });
    expect(components[1]?.capabilities.test).toEqual(["cargo", "test", "--locked"]);
  });

  test("the fast plan runs each Cargo gate once for a workspace", () => {
    const root = workspace('[workspace]\nmembers = ["backend", "rune-lanes-core"]\n');
    crate(root, "backend", "backend");
    crate(root, "rune-lanes-core", "rune-lanes-core");

    const plan = planChecks({ root, tier: "fast" });

    expect(plan.checks.map((check) => `${check.path}:${check.command.join(" ")}`)).toEqual([
      ".:cargo fmt --all --check",
      ".:cargo clippy --workspace --all-targets --all-features -- -D warnings",
      ".:cargo test --workspace --locked --lib",
      ".:cargo build --workspace --locked",
    ]);
  });

  test("a package that is also a workspace root keeps its members inside the workspace component", () => {
    const root = workspace(
      '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2024"\n\n[workspace]\nmembers = ["./plugins/one/"]\n',
    );
    crate(root, "plugins/one", "one");

    const components = discoverComponents(root).filter((component) => component.kind === "rust");

    expect(components.map((component) => component.path)).toEqual(["."]);
    expect(components[0]?.capabilities.test).toEqual(["cargo", "test", "--workspace", "--locked"]);
  });
});
