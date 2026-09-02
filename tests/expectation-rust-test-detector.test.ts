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
    join(root, "tests", "service_contract.rs"),
    "use rust_fixture::service::value;\n\n#[test]\nfn service_is_reachable() { assert_eq!(value(), 3); }\n",
  );
  return root;
}

describe("Rust test expectations", () => {
  test("reports only Rust sources without conservative test evidence", () => {
    const findings = missingRustTestFindings(createDetectorContext(fixture()));

    expect(findings.map((finding) => finding.subject.key)).toEqual(["src/orphan.rs"]);
    expect(findings[0]?.verification).toEqual([
      ["cargo", "test", "--locked", "--manifest-path", "Cargo.toml"],
    ]);
    expect(findings[0]?.scaffold).toBeUndefined();
  });

  test("recognizes crate names with Cargo hyphens and direct module paths", () => {
    const root = fixture();
    const context = createDetectorContext(root);

    expect(context.rustPackages[0]?.crateName).toBe("rust_fixture");
    expect(context.rustPackages[0]?.sourceFiles).toHaveLength(4);
  });

  test("recognizes simple rustfmt-style grouped module imports", () => {
    const root = fixture();
    writeFileSync(
      join(root, "tests", "service_contract.rs"),
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

  test("does not guess through public re-exports", () => {
    const root = fixture();
    writeFileSync(
      join(root, "src", "lib.rs"),
      "pub mod inline;\npub mod orphan;\nmod service;\npub use service::value;\n",
    );
    writeFileSync(
      join(root, "tests", "service_contract.rs"),
      "use rust_fixture::value;\n\n#[test]\nfn public_value_is_reachable() { assert_eq!(value(), 3); }\n",
    );

    const findings = missingRustTestFindings(createDetectorContext(root));
    expect(findings.map((finding) => finding.subject.key)).toEqual([
      "src/orphan.rs",
      "src/service.rs",
    ]);
  });
});
