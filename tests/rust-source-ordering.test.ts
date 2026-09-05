import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

import { runConventionChecks } from "../src/convention-enforcement.ts";
import { discoverComponents } from "../src/core.ts";

function rustRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-rust-order-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "ordering_fixture"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  const directory = join(root, ".conventions", "modules", "fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "RUST-004.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ruleId: "RUST-004",
        enforcement: { kind: "builtin", check: "rust-source-order" },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

test("orders Rust module groups and trait item kinds without alphabetizing implementations", () => {
  const root = rustRepository();
  const source = join(root, "src", "lib.rs");

  writeFileSync(
    source,
    `mod inner {}\nuse std::fmt;\nconst VALUE: usize = 1;\nstruct Thing;\ntrait Sample { const VALUE: usize; type Item; fn run(&self); }\nimpl Thing { fn z(&self) {} fn a(&self) {} }\nfn run() { let _ = fmt::Error; }\n`,
  );
  expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

  writeFileSync(
    source,
    `fn run() {}\nstruct Thing;\ntrait Sample { fn run(&self); type Item; const VALUE: usize; }\n`,
  );
  const failed = runConventionChecks(root, discoverComponents(root));
  expect(failed.status).toBe("failed");
  expect(failed.diagnostics[0]?.message).toContain("canonical Rust module-group order");
});

test("checks inline Rust modules and trait kind order", () => {
  const root = rustRepository();
  const source = join(root, "src", "lib.rs");

  writeFileSync(
    source,
    `mod nested {\n    use std::fmt;\n    struct Thing;\n    fn run() { let _ = fmt::Error; }\n}\ntrait Sample {\n    fn run(&self);\n    type Item;\n}\n`,
  );
  const failed = runConventionChecks(root, discoverComponents(root));
  expect(failed.status).toBe("failed");
  expect(failed.diagnostics[0]?.message).toContain(
    "associated type must appear before previously declared associated function",
  );
});

test("does not order Rust impl methods, struct fields, or enum variants", () => {
  const root = rustRepository();
  writeFileSync(
    join(root, "src", "lib.rs"),
    `struct Thing { z: usize, a: usize }\nenum Choice { Z, A }\nimpl Thing { fn z(&self) {} fn a(&self) {} }\n`,
  );

  expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
});

test("allows cfg-test modules at the bottom and ignores item-like text in strings and comments", () => {
  const root = rustRepository();
  writeFileSync(
    join(root, "src", "lib.rs"),
    `const TEXT: &str = r#"fn fake() {} struct Fake;"#;\nstruct Thing;\nfn run() { let _ = TEXT; }\n/* mod fake {} */\n#[cfg(test)]\nmod tests {\n    fn helper() {}\n    struct TestOnly;\n}\n`,
  );

  expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
});
