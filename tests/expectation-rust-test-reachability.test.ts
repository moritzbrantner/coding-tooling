import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations, findingsCommand } from "../src/expectations.ts";
import type { FindingsCoverage } from "../src/expectation-coverage.ts";
import { rustTestSurfaces } from "../src/expectation-rust-test-detector.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name = "fixture-service"): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-rust-tests-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "Cargo.toml"),
    `[package]\nname = ${JSON.stringify(name)}\nversion = "0.1.0"\n`,
  );
  return root;
}

function rustFindings(root: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === "rust-source-test",
  );
}

function coverage(root: string): FindingsCoverage {
  return findingsCommand(root).data.coverage as FindingsCoverage;
}

describe("Rust structural test reachability", () => {
  test("reports a stable missing-test finding for reachable Rust source without evidence", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "lib.rs"), "pub mod service;\n");
    writeFileSync(join(root, "src", "service.rs"), "pub fn value() -> u8 { 1 }\n");

    const before = rustFindings(root).find((finding) => finding.subject.key === "src/service.rs");
    expect(before).toBeDefined();
    expect(before?.verification).toEqual([["cargo", "test"]]);
    expect(before?.scaffold).toBeUndefined();

    writeFileSync(join(root, "README.md"), "unrelated\n");
    const after = rustFindings(root).find((finding) => finding.subject.key === "src/service.rs");
    expect(after?.id).toBe(before?.id);
  });

  test("inline cfg(test) unit module satisfies the source finding", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "lib.rs"), "pub mod service;\n");
    writeFileSync(
      join(root, "src", "service.rs"),
      `pub fn value() -> u8 { 1 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn value_is_one() { assert_eq!(super::value(), 1); }\n}\n`,
    );

    expect(
      rustFindings(root).some((finding) => finding.subject.key === "src/service.rs"),
    ).toBeFalse();
  });

  test("integration test crate reference seeds the library module graph conservatively", () => {
    const root = fixture();
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "lib.rs"), "pub mod service;\n");
    writeFileSync(join(root, "src", "service.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(
      join(root, "tests", "service.rs"),
      "use fixture_service::service;\n\n#[test]\nfn service_is_visible() { let _ = service::value(); }\n",
    );

    expect(rustFindings(root)).toEqual([]);
    expect(
      coverage(root).detectors.find((detector) => detector.id === "rust-source-test"),
    ).toMatchObject({ status: "applied", subjects: 2 });
    expect(coverage(root).unsupportedTechnologies).toEqual(["rust"]);
  });

  test("follows explicit path test-support modules before recognizing crate evidence", () => {
    const root = fixture();
    mkdirSync(join(root, "tests", "support"), { recursive: true });
    writeFileSync(join(root, "src", "lib.rs"), "pub mod service;\n");
    writeFileSync(join(root, "src", "service.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(
      join(root, "tests", "validation.rs"),
      '#[path = "support/assertions.rs"]\nmod assertions;\n\n#[test]\nfn validates() { assertions::check(); }\n',
    );
    writeFileSync(
      join(root, "tests", "support", "assertions.rs"),
      "use fixture_service::service;\n\npub fn check() { let _ = service::value(); }\n",
    );

    expect(rustFindings(root)).toEqual([]);
  });

  test("binary integration evidence recognizes Cargo's CARGO_BIN_EXE signal", () => {
    const root = fixture("fixture-bin");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "main.rs"), "fn main() {}\n");
    writeFileSync(
      join(root, "tests", "cli.rs"),
      'const BIN: &str = env!("CARGO_BIN_EXE_fixture-bin");\n\n#[test]\nfn binary_exists() { assert!(!BIN.is_empty()); }\n',
    );

    expect(rustFindings(root)).toEqual([]);
  });

  test("binary source without inline or CARGO_BIN_EXE evidence remains a finding", () => {
    const root = fixture("fixture-bin");
    writeFileSync(join(root, "src", "main.rs"), "fn main() {}\n");

    const finding = rustFindings(root).find((item) => item.subject.key === "src/main.rs");
    expect(finding).toBeDefined();
    expect(finding?.scaffold).toBeUndefined();
  });

  test("conditional module relationships remain outside the proven surface", () => {
    const root = fixture();
    writeFileSync(
      join(root, "src", "lib.rs"),
      '#[cfg(feature = "extra")]\nmod gated;\npub mod service;\n',
    );
    writeFileSync(join(root, "src", "gated.rs"), "pub fn gated() {}\n");
    writeFileSync(join(root, "src", "service.rs"), "pub fn value() -> u8 { 1 }\n");

    expect(rustTestSurfaces(root)).toEqual(["src/lib.rs", "src/service.rs"]);
    expect(coverage(root).unsupportedTechnologies).toEqual(["rust"]);
  });

  test("inline tests in the crate root structurally reach unconditional child modules", () => {
    const root = fixture();
    writeFileSync(
      join(root, "src", "lib.rs"),
      `pub mod service;\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn smoke() { assert!(true); }\n}\n`,
    );
    writeFileSync(join(root, "src", "service.rs"), "pub fn value() -> u8 { 1 }\n");

    expect(rustFindings(root)).toEqual([]);
  });
});
