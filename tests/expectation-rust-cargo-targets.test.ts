import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeExpectations, findingsCommand } from "../src/expectations.ts";
import type { FindingsCoverage } from "../src/expectation-coverage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifest: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-rust-targets-"));
  roots.push(root);
  writeFileSync(join(root, "Cargo.toml"), `${manifest.trim()}\n`);
  return root;
}

function rustFindings(root: string) {
  return analyzeExpectations(root).findings.filter(
    (finding) => finding.expectationId === "rust-cargo-target-path",
  );
}

function coverage(root: string): FindingsCoverage {
  return findingsCommand(root).data.coverage as FindingsCoverage;
}

describe("explicit Cargo target path findings", () => {
  test("reports an explicit Cargo test target whose path is missing", () => {
    const root = fixture(`
      [package]
      name = "fixture"
      version = "0.1.0"

      [[test]]
      name = "contract"
      path = "tests/contract.rs"
    `);

    const findings = rustFindings(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.subject.key).toBe("Cargo.toml#test:contract");
    expect(findings[0]?.requirement.expectedArtifact).toBe("tests/contract.rs");
    expect(findings[0]?.message).toContain("missing path tests/contract.rs");
  });

  test("reports multiple explicit target kinds independently", () => {
    const root = fixture(`
      [package]
      name = "fixture"
      version = "0.1.0"

      [lib]
      path = "src/custom.rs"

      [[bin]]
      name = "worker"
      path = "src/worker.rs"

      [[example]]
      name = "demo"
      path = "examples/demo.rs"

      [[bench]]
      name = "throughput"
      path = "benches/throughput.rs"
    `);

    const findings = rustFindings(root);

    expect(findings).toHaveLength(4);
    expect(new Set(findings.map((finding) => finding.requirement.expectedArtifact))).toEqual(
      new Set(["src/custom.rs", "src/worker.rs", "examples/demo.rs", "benches/throughput.rs"]),
    );
  });

  test("clean explicit target paths produce no finding while detector coverage is applied", () => {
    const root = fixture(`
      [package]
      name = "fixture"
      version = "0.1.0"

      [[test]]
      name = "contract"
      path = "tests/contract.rs"
    `);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "contract.rs"), "#[test]\nfn contract() {}\n");

    expect(rustFindings(root)).toEqual([]);
    const result = coverage(root);
    expect(
      result.detectors.find((detector) => detector.id === "rust-cargo-target-path"),
    ).toMatchObject({ status: "applied", subjects: 1 });
    expect(result.unsupportedTechnologies).toEqual(["rust"]);
  });

  test("implicit Cargo targets remain outside this first explicit-path contract", () => {
    const root = fixture(`
      [package]
      name = "fixture"
      version = "0.1.0"
    `);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "lib.rs"), "pub fn value() -> u8 { 1 }\n");

    expect(rustFindings(root)).toEqual([]);
    expect(
      coverage(root).detectors.find((detector) => detector.id === "rust-cargo-target-path"),
    ).toMatchObject({ status: "not-applicable", subjects: 0 });
  });

  test("semantic finding IDs stay stable across unrelated edits", () => {
    const root = fixture(`
      [package]
      name = "fixture"
      version = "0.1.0"

      [[test]]
      name = "contract"
      path = "tests/contract.rs"
    `);
    const before = rustFindings(root)[0]?.id;

    writeFileSync(join(root, "README.md"), "unrelated\n");

    expect(rustFindings(root)[0]?.id).toBe(before);
  });

  test("supports conservative single-quoted Cargo path literals", () => {
    const root = fixture(`
      [package]
      name = "fixture"
      version = "0.1.0"

      [lib]
      path = 'src/custom.rs'
    `);

    expect(rustFindings(root)[0]?.requirement.expectedArtifact).toBe("src/custom.rs");
  });
});
