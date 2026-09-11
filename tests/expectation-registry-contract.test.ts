import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dotNetAssignabilityFindings,
  typeScriptAssignabilityFindings,
} from "../src/expectation-analysis-detector.ts";
import type { DetectorContext } from "../src/expectation-package-context.ts";
import type { RawFinding } from "../src/expectation-detector-types.ts";
import { expectationDescriptors, expectationRegistry } from "../src/expectation-detectors.ts";
import {
  missingBenchmarkEvidenceFindings,
  missingTestCapabilityFindings,
  sourceDebtMarkerFindings,
  sourceUnimplementedStubFindings,
  sourceWorkMarkerFindings,
} from "../src/expectation-gap-detectors.ts";
import { duplicateValues, semanticFindingId } from "../src/expectation-model.ts";
import {
  missingAggregateCheckFindings,
  missingCliWiringFindings,
  missingRequiredCapabilityFindings,
  missingTypeScriptConfigFindings,
} from "../src/expectation-package-detectors.ts";
import { createDetectorContext } from "../src/expectation-package-context.ts";
import { missingCargoTargetPathFindings } from "../src/expectation-rust-detector.ts";
import { missingRustTestFindings } from "../src/expectation-rust-test-detector.ts";
import {
  missingJavaScriptTestFindings,
  missingTestFindings,
} from "../src/expectation-test-detector.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-expectation-registry-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        scripts: { lint: "oxlint .", test: "bun test" },
        bin: { fixture: "src/cli.ts" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");
  return root;
}

function detectorBatches(context: DetectorContext): RawFinding[][] {
  return [
    missingBenchmarkEvidenceFindings(context),
    dotNetAssignabilityFindings(context),
    missingJavaScriptTestFindings(context),
    missingAggregateCheckFindings(context),
    missingCliWiringFindings(context),
    missingTestCapabilityFindings(context),
    missingRequiredCapabilityFindings(context),
    missingCargoTargetPathFindings(context),
    missingRustTestFindings(context),
    sourceDebtMarkerFindings(context),
    sourceUnimplementedStubFindings(context),
    sourceWorkMarkerFindings(context),
    missingTypeScriptConfigFindings(context),
    missingTestFindings(context),
    typeScriptAssignabilityFindings(context),
  ];
}

describe("expectation detector registry contract", () => {
  test("exposes versioned deterministic detector metadata", () => {
    const registry = expectationRegistry();

    expect(registry.map((entry) => entry.id)).toEqual([
      "benchmark-evidence",
      "deployment-runtime-parity",
      "dotnet-type-assignability",
      "javascript-source-test",
      "package-aggregate-check",
      "package-cli-wiring",
      "package-test-capability",
      "required-capability-available",
      "rust-cargo-target-path",
      "rust-source-test",
      "source-debt-marker",
      "source-unimplemented-stub",
      "source-work-marker",
      "typescript-project-config",
      "typescript-source-test",
      "typescript-type-assignability",
    ]);
    expect(registry.map((entry) => [entry.id, entry.version])).toEqual([
      ["benchmark-evidence", 1],
      ["deployment-runtime-parity", 1],
      ["dotnet-type-assignability", 1],
      ["javascript-source-test", 1],
      ["package-aggregate-check", 1],
      ["package-cli-wiring", 1],
      ["package-test-capability", 1],
      ["required-capability-available", 1],
      ["rust-cargo-target-path", 1],
      ["rust-source-test", 1],
      ["source-debt-marker", 2],
      ["source-unimplemented-stub", 1],
      ["source-work-marker", 1],
      ["typescript-project-config", 1],
      ["typescript-source-test", 2],
      ["typescript-type-assignability", 1],
    ]);
    expect(registry.every((entry) => entry.policyKind === "advisory")).toBeTrue();
    expect(expectationDescriptors.map((entry) => entry.id)).toEqual(
      registry.map((entry) => entry.id),
    );
  });

  test("publishes bounded evidence claims without inventing confidence", () => {
    const registry = expectationRegistry();

    expect(
      registry.every(
        (entry) =>
          entry.evidenceContract.oracle.length > 0 &&
          entry.evidenceContract.independenceKey.length > 0 &&
          entry.evidenceContract.proves.length > 0 &&
          entry.evidenceContract.limitations.length > 0,
      ),
    ).toBeTrue();

    const typescriptAssignability = registry.find(
      (entry) => entry.id === "typescript-type-assignability",
    );
    expect(typescriptAssignability?.evidenceContract).toMatchObject({
      basis: "semantic",
      oracle: "typescript-compiler",
      independenceKey: "typescript-compiler",
    });

    const dotNetAssignability = registry.find((entry) => entry.id === "dotnet-type-assignability");
    expect(dotNetAssignability?.evidenceContract).toMatchObject({
      basis: "semantic",
      oracle: "dotnet-roslyn",
      independenceKey: "dotnet-roslyn",
    });

    const testReachabilityKeys = registry
      .filter((entry) =>
        ["javascript-source-test", "rust-source-test", "typescript-source-test"].includes(entry.id),
      )
      .map((entry) => entry.evidenceContract.independenceKey);
    expect(testReachabilityKeys).toEqual([
      "static-test-reachability",
      "static-test-reachability",
      "static-test-reachability",
    ]);

    const sourceScanKeys = registry
      .filter((entry) => ["source-debt-marker", "source-unimplemented-stub"].includes(entry.id))
      .map((entry) => entry.evidenceContract.independenceKey);
    expect(sourceScanKeys).toEqual(["source-text-scan", "source-text-scan"]);
    expect(
      registry.find((entry) => entry.id === "source-work-marker")?.evidenceContract,
    ).toMatchObject({
      basis: "syntax",
      oracle: "bounded-structured-work-marker-scan",
      independenceKey: "source-work-marker-scan",
    });
  });

  test("versions semantic IDs and keeps detector output deterministic", () => {
    const v1 = semanticFindingId(
      "typescript-source-test",
      1,
      "src/service.ts",
      "tests/service.test.ts",
    );
    const repeated = semanticFindingId(
      "typescript-source-test",
      1,
      "src/service.ts",
      "tests/service.test.ts",
    );
    const v2 = semanticFindingId(
      "typescript-source-test",
      2,
      "src/service.ts",
      "tests/service.test.ts",
    );

    expect(repeated).toBe(v1);
    expect(v2).not.toBe(v1);
    expect(duplicateValues(["a", "b", "a"])).toEqual(["a"]);

    const root = fixture();
    const batches = detectorBatches(createDetectorContext(root));
    const repeatedBatches = detectorBatches(createDetectorContext(root));

    expect(repeatedBatches).toEqual(batches);
    expect(batches.map((batch) => batch.length)).toEqual([
      0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0,
    ]);
  });
});
