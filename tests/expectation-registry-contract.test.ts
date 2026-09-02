import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RawFinding } from "../src/expectation-detector-types.ts";
import { expectationDescriptors, expectationRegistry } from "../src/expectation-detectors.ts";
import {
  missingBenchmarkEvidenceFindings,
  missingTestCapabilityFindings,
  sourceDebtMarkerFindings,
  sourceUnimplementedStubFindings,
} from "../src/expectation-gap-detectors.ts";
import { duplicateValues, semanticFindingId } from "../src/expectation-model.ts";
import {
  missingAggregateCheckFindings,
  missingCliWiringFindings,
  missingRequiredCapabilityFindings,
  missingTypeScriptConfigFindings,
} from "../src/expectation-package-detectors.ts";
import { createDetectorContext } from "../src/expectation-package-context.ts";
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

describe("expectation detector registry contract", () => {
  test("exposes versioned deterministic detector metadata", () => {
    const registry = expectationRegistry();

    expect(registry.map((entry) => entry.id)).toEqual([
      "benchmark-evidence",
      "javascript-source-test",
      "package-aggregate-check",
      "package-cli-wiring",
      "package-test-capability",
      "required-capability-available",
      "source-debt-marker",
      "source-unimplemented-stub",
      "typescript-project-config",
      "typescript-source-test",
    ]);
    expect(registry.map((entry) => [entry.id, entry.version])).toEqual([
      ["benchmark-evidence", 1],
      ["javascript-source-test", 1],
      ["package-aggregate-check", 1],
      ["package-cli-wiring", 1],
      ["package-test-capability", 1],
      ["required-capability-available", 1],
      ["source-debt-marker", 1],
      ["source-unimplemented-stub", 1],
      ["typescript-project-config", 1],
      ["typescript-source-test", 2],
    ]);
    expect(registry.every((entry) => entry.policyKind === "advisory")).toBeTrue();
    expect(expectationDescriptors.map((entry) => entry.id)).toEqual(
      registry.map((entry) => entry.id),
    );
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

    const context = createDetectorContext(fixture());
    const batches: RawFinding[][] = [
      missingBenchmarkEvidenceFindings(context),
      missingJavaScriptTestFindings(context),
      missingAggregateCheckFindings(context),
      missingCliWiringFindings(context),
      missingTestCapabilityFindings(context),
      missingRequiredCapabilityFindings(context),
      sourceDebtMarkerFindings(context),
      sourceUnimplementedStubFindings(context),
      missingTypeScriptConfigFindings(context),
      missingTestFindings(context),
    ];

    expect(batches.map((batch) => batch.length)).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 1, 1]);
  });
});
