import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deploymentRuntimeParityFindings } from "../src/expectation-deployment-detector.ts";
import { createDetectorContext } from "../src/expectation-detectors.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(workflow: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-deploy-parity-"));
  roots.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "pages.yml"), workflow);
  return root;
}

describe("deployment runtime parity", () => {
  test("finds a Pages-only runtime variant that is not exercised from the deploy artifact", () => {
    const root = fixture(`
permissions:
  pages: write
jobs:
  build:
    steps:
      - run: VITE_MAPS_WASM_SHOWCASE=1 bunx vite build --base /maps/
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
  browser:
    steps:
      - run: bun run test:browser:smoke
`);

    const findings = deploymentRuntimeParityFindings(createDetectorContext(root));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.requirement.key).toBe("deployment-runtime-parity");
    expect(findings[0]?.evidence.map((entry) => entry.detail)).toContain(
      "production environment VITE_MAPS_WASM_SHOWCASE",
    );
  });

  test("accepts browser validation that consumes the exact produced artifact", () => {
    const root = fixture(`
permissions:
  pages: write
jobs:
  build:
    uses: owner/reusable/.github/workflows/build-artifact.yml@0123456789012345678901234567890123456789
    with:
      build_command: VITE_MAPS_WASM_SHOWCASE=1 bunx vite build --base /maps/
      artifact_paths: dist
  verify-hosted:
    needs: build
    uses: owner/reusable/.github/workflows/e2e-validation.yml@0123456789012345678901234567890123456789
    with:
      prebuilt_artifact_run_id: producer-run
      prebuilt_artifact_digest: producer-digest
      e2e_command: bunx playwright test --config playwright.hosted.config.ts
  deploy:
    needs: [build, verify-hosted]
    uses: owner/reusable/.github/workflows/deploy-pages.yml@0123456789012345678901234567890123456789
`);

    expect(deploymentRuntimeParityFindings(createDetectorContext(root))).toEqual([]);
  });

  test("does not demand browser parity for a Pages workflow without a runtime-specific build variant", () => {
    const root = fixture(`
permissions:
  pages: write
jobs:
  build:
    steps:
      - run: bun run build
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
`);

    expect(deploymentRuntimeParityFindings(createDetectorContext(root))).toEqual([]);
  });

  test("ignores public runtime variables that are not part of a build command", () => {
    const root = fixture(`
permissions:
  pages: write
jobs:
  build:
    steps:
      - run: bun run build
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
  diagnostics:
    steps:
      - run: VITE_DIAGNOSTIC_MODE=1 bun run inspect
`);

    expect(deploymentRuntimeParityFindings(createDetectorContext(root))).toEqual([]);
  });
});
