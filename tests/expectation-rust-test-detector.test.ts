import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDetectorContext } from "../src/expectation-package-context.ts";
import { missingRustTestFindings } from "../src/expectation-rust-test-detector.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-rust-test-expectation-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "rust-fixture"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  writeFileSync(join(root, "Cargo.lock"), "");
  writeFileSync(
    join(root, "src", "lib.rs"),
    "pub mod inline;\npub mod orphan;\npub mod service;\n",
  );
  writeFileSync(
    join(root, "src", "inline.rs"),
    [
      "pub fn value() -> u8 { 1 }",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn returns_value() {",
      "        assert_eq!(super::value(), 1);",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src", "orphan.rs"), "pub fn value() -> u8 { 2 }\n");
  writeFileSync(join(root, "src", "service.rs"), "pub fn value() -> u8 { 3 }\n");
  writeFileSync(
    join(root, "tests", "isolated.rs"),
    "#[test]\nfn isolated() { assert_eq!(1 + 1, 2); }\n",
  );
  return root;
}

function findingSubjects(root: string): string[] {
  return missingRustTestFindings(createDetectorContext(root)).map((finding) => finding.subject.key);
}

describe("Rust test expectations", () => {
  test("reports declared library sources without inline or integration evidence", () => {
    const findings = missingRustTestFindings(createDetectorContext(fixture()));

    expect(findings.map((finding) => finding.subject.key)).toEqual([
      "src/lib.rs",
      "src/orphan.rs",
      "src/service.rs",
    ]);
    expect(findings[0]?.verification).toEqual([
      ["cargo", "test", "--locked", "--manifest-path", "Cargo.toml"],
    ]);
    expect(findings.every((finding) => finding.scaffold === undefined)).toBeTrue();
  });

  test("recognizes crate names and executable Cargo test roots", () => {
    const root = fixture();
    const context = createDetectorContext(root);

    expect(context.rustPackages[0]?.crateName).toBe("rust_fixture");
    expect(context.rustPackages[0]?.sourceFiles).toHaveLength(4);
    expect(context.rustPackages[0]?.integrationTestRoots).toEqual([
      join(root, "tests", "isolated.rs"),
    ]);
    expect(context.rustPackages[0]?.hasLockfile).toBeTrue();
  });

  test("treats a public integration import as structural evidence for the library graph", () => {
    const root = fixture();
    writeFileSync(
      join(root, "tests", "isolated.rs"),
      "use rust_fixture::service::value;\n\n#[test]\nfn service_is_reachable() { assert_eq!(value(), 3); }\n",
    );

    expect(missingRustTestFindings(createDetectorContext(root))).toEqual([]);
  });

  test("recognizes rustfmt-style grouped imports at the public crate seam", () => {
    const root = fixture();
    writeFileSync(
      join(root, "tests", "isolated.rs"),
      [
        "use rust_fixture::{orphan::value, service::value as service_value};",
        "",
        "#[test]",
        "fn modules_are_reachable() {",
        "    assert_eq!(value(), 2);",
        "    assert_eq!(service_value(), 3);",
        "}",
        "",
      ].join("\n"),
    );

    expect(missingRustTestFindings(createDetectorContext(root))).toEqual([]);
  });

  test("does not accept comments or strings as inline test evidence", () => {
    const root = fixture();
    writeFileSync(
      join(root, "src", "inline.rs"),
      [
        "pub fn value() -> u8 { 1 }",
        'const FAKE: &str = r#"#[cfg(test)] #[test]"#;',
        "// #[cfg(test)]",
        "// #[test]",
        "",
      ].join("\n"),
    );

    expect(findingSubjects(root)).toEqual([
      "src/inline.rs",
      "src/lib.rs",
      "src/orphan.rs",
      "src/service.rs",
    ]);
  });

  test("preserves inline tests after quote character literals", () => {
    const root = fixture();
    writeFileSync(
      join(root, "src", "inline.rs"),
      [
        "pub const QUOTE: char = '\\"';",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "    #[test]",
        "    fn quote_is_preserved() {",
        "        assert_eq!(super::QUOTE, '\\"');",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    expect(findingSubjects(root)).toEqual(["src/lib.rs", "src/orphan.rs", "src/service.rs"]);
  });

  test("does not accept comments or strings as integration import evidence", () => {
    const root = fixture();
    writeFileSync(
      join(root, "tests", "isolated.rs"),
      [
        'const FAKE: &str = "use rust_fixture::service::value;";',
        "// use rust_fixture::orphan::value;",
        "#[test]",
        "fn isolated() { assert_eq!(1 + 1, 2); }",
        "",
      ].join("\n"),
    );

    expect(findingSubjects(root)).toEqual(["src/lib.rs", "src/orphan.rs", "src/service.rs"]);
  });

  test("does not count an unreachable nested integration helper", () => {
    const root = fixture();
    mkdirSync(join(root, "tests", "common"), { recursive: true });
    writeFileSync(
      join(root, "tests", "common", "mod.rs"),
      "use rust_fixture::service::value;\npub fn helper() -> u8 { value() }\n",
    );

    expect(findingSubjects(root)).toEqual(["src/lib.rs", "src/orphan.rs", "src/service.rs"]);
  });

  test("follows modules reachable from a Cargo integration-test root", () => {
    const root = fixture();
    mkdirSync(join(root, "tests", "common"), { recursive: true });
    writeFileSync(
      join(root, "tests", "common", "mod.rs"),
      "use rust_fixture::service::value;\npub fn helper() -> u8 { value() }\n",
    );
    writeFileSync(
      join(root, "tests", "isolated.rs"),
      "mod common;\n\n#[test]\nfn service_is_reachable() { assert_eq!(common::helper(), 3); }\n",
    );

    expect(missingRustTestFindings(createDetectorContext(root))).toEqual([]);
  });

  test("honors Cargo autotests comments and explicit test targets", () => {
    const root = fixture();
    writeFileSync(
      join(root, "tests", "isolated.rs"),
      "use rust_fixture::service::value;\n\n#[test]\nfn service_is_reachable() { assert_eq!(value(), 3); }\n",
    );
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "rust-fixture"\nversion = "0.1.0"\nedition = "2024"\nautotests = false # intentionally disabled\n',
    );
    expect(findingSubjects(root)).toEqual(["src/lib.rs", "src/orphan.rs", "src/service.rs"]);

    mkdirSync(join(root, "tests", "custom"), { recursive: true });
    writeFileSync(
      join(root, "tests", "custom", "contract.rs"),
      "use rust_fixture::service::value;\n\n#[test]\nfn service_is_reachable() { assert_eq!(value(), 3); }\n",
    );
    writeFileSync(
      join(root, "Cargo.toml"),
      [
        "[package]",
        'name = "rust-fixture"',
        'version = "0.1.0"',
        'edition = "2024"',
        "autotests = false",
        "",
        "[[test]]",
        'name = "contract"',
        'path = "tests/custom/contract.rs"',
        "",
      ].join("\n"),
    );

    expect(missingRustTestFindings(createDetectorContext(root))).toEqual([]);
  });

  test("omits --locked when the package has no lockfile", () => {
    const root = fixture();
    rmSync(join(root, "Cargo.lock"));
    const findings = missingRustTestFindings(createDetectorContext(root));

    expect(findings[0]?.verification).toEqual([["cargo", "test", "--manifest-path", "Cargo.toml"]]);
  });

  test("does not inherit an unrelated ancestor Cargo lockfile", () => {
    const root = fixture();
    const nested = join(root, "standalone");
    mkdirSync(join(nested, "src"), { recursive: true });
    writeFileSync(
      join(nested, "Cargo.toml"),
      '[package]\nname = "standalone"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    writeFileSync(join(nested, "src", "lib.rs"), "pub fn value() -> u8 { 1 }\n");

    const finding = missingRustTestFindings(createDetectorContext(root)).find(
      (item) => item.subject.key === "standalone/src/lib.rs",
    );
    expect(finding?.verification).toEqual([
      ["cargo", "test", "--manifest-path", "standalone/Cargo.toml"],
    ]);
  });

  test("follows ordinary nested library module declarations", () => {
    const root = fixture();
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    writeFileSync(join(root, "src", "routes", "mod.rs"), "mod handler;\n");
    writeFileSync(join(root, "src", "routes", "handler.rs"), "pub fn handle() {}\n");
    writeFileSync(
      join(root, "src", "lib.rs"),
      "pub mod inline;\npub mod orphan;\npub mod routes;\npub mod service;\n",
    );

    expect(findingSubjects(root)).toEqual([
      "src/lib.rs",
      "src/orphan.rs",
      "src/routes/handler.rs",
      "src/routes/mod.rs",
      "src/service.rs",
    ]);
  });

  test("resolves out-of-line children declared inside inline module scopes", () => {
    const root = fixture();
    mkdirSync(join(root, "src", "outer"), { recursive: true });
    writeFileSync(join(root, "src", "outer", "service.rs"), "pub fn nested() -> u8 { 4 }\n");
    writeFileSync(
      join(root, "src", "lib.rs"),
      "pub mod inline;\npub mod orphan;\npub mod outer { pub mod service; }\npub mod service;\n",
    );

    expect(findingSubjects(root)).toEqual([
      "src/lib.rs",
      "src/orphan.rs",
      "src/outer/service.rs",
      "src/service.rs",
    ]);
  });

  test("ignores binary, undeclared, and attributed module files rather than guessing", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "main.rs"), "fn main() {}\n");
    writeFileSync(join(root, "src", "unused.rs"), "pub fn unused() {}\n");
    writeFileSync(join(root, "src", "optional.rs"), "pub fn optional() {}\n");
    writeFileSync(
      join(root, "src", "lib.rs"),
      [
        "pub mod inline;",
        "pub mod orphan;",
        '#[cfg(feature = "optional")]',
        "pub mod optional;",
        "pub mod service;",
        "",
      ].join("\n"),
    );

    expect(findingSubjects(root)).toEqual(["src/lib.rs", "src/orphan.rs", "src/service.rs"]);
  });
});
