import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverPublicContract,
  publicContractCommand,
  type PublicContractReport,
} from "../src/public-contract.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-public-contract-"));
  roots.push(root);
  return root;
}

function report(root: string): PublicContractReport {
  return publicContractCommand(root).data as unknown as PublicContractReport;
}

describe("public contract verification", () => {
  test("discovers package exports and CLI boundaries from package metadata", () => {
    const root = fixture();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        exports: { ".": "./src/index.ts", "./extra": "./src/extra.ts" },
        bin: { fixture: "./src/cli.ts" },
      }),
    );

    const surfaces = discoverPublicContract(root);

    expect(surfaces.map((surface) => [surface.kind, surface.subject])).toEqual([
      ["cli-command", "fixture"],
      ["package-export", "fixture-package"],
      ["package-export", "fixture-package/extra"],
    ]);
    expect(surfaces.find((surface) => surface.kind === "cli-command")?.discovery.status).toBe(
      "partial",
    );
    expect(
      surfaces
        .filter((surface) => surface.kind === "package-export")
        .every((surface) => surface.discovery.status === "complete"),
    ).toBe(true);
  });

  test("maps framework-independent capability evidence to a public surface", () => {
    const root = fixture();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        exports: "./src/index.ts",
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    );
    writeFileSync(
      join(root, ".coding-tooling.contracts.json"),
      JSON.stringify({
        schemaVersion: 1,
        verifications: [
          {
            id: "root-export-behavior",
            surface: "package-export:fixture-package:.",
            kind: "behavioral",
            capability: "test:unit",
          },
        ],
      }),
    );

    const result = publicContractCommand(root);
    const data = result.data as unknown as PublicContractReport;

    expect(result.status).toBe("passed");
    expect(data.summary).toMatchObject({ discovered: 1, verified: 1, unverified: 0 });
    expect(data.surfaces[0]?.evidence[0]).toMatchObject({
      id: "root-export-behavior",
      kind: "behavioral",
      capability: "test:unit",
      outcome: "passed",
    });
  });

  test("does not count reachability alone as public-contract verification", () => {
    const root = fixture();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        exports: "./src/index.ts",
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    );
    writeFileSync(
      join(root, ".coding-tooling.contracts.json"),
      JSON.stringify({
        schemaVersion: 1,
        verifications: [
          {
            id: "root-export-reachability",
            surface: "package-export:fixture-package:.",
            kind: "reachability",
            capability: "test:unit",
          },
        ],
      }),
    );

    const data = report(root);

    expect(data.summary).toMatchObject({ discovered: 1, verified: 0, unverified: 1 });
    expect(data.surfaces[0]?.evidence[0]?.outcome).toBe("passed");
  });

  test("keeps incomplete Rust item discovery separate from verification", () => {
    const root = fixture();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "fixture-rust"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(root, "src", "lib.rs"), "pub fn value() -> u8 { 1 }\n");

    const data = report(root);

    expect(data.summary).toMatchObject({ discovered: 1, verified: 0, unsupported: 1 });
    expect(data.unsupportedAnalyzers).toContain("rust-item-api");
  });

  test("strict mode fails rather than treating unknown or unverified surfaces as clean", () => {
    const root = fixture();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-package", exports: "./src/index.ts" }),
    );
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({ schemaVersion: 1, contracts: { enforcement: "strict" } }),
    );

    const result = publicContractCommand(root);
    const data = result.data as unknown as PublicContractReport;

    expect(result.status).toBe("failed");
    expect(data.summary.strictReady).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("public-contract-not-strict-ready");
  });
});
