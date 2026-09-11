import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeFindingsCoverage } from "../src/expectation-coverage.ts";
import { createDetectorContext, expectationDescriptors } from "../src/expectation-detectors.ts";
import { repositoryScoreCommand } from "../src/repository-score.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-deploy-parity-integration-"));
  roots.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".coding-tooling.json"),
    JSON.stringify({ schemaVersion: 1, requiredCapabilities: [] }),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", packageManager: "bun@1.4.0", scripts: {} }),
  );
  writeFileSync(
    join(root, ".github", "workflows", "pages.yml"),
    `
permissions:
  pages: write
jobs:
  build:
    steps:
      - run: VITE_HOSTED_RUNTIME=1 bunx vite build --base /fixture/
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
`,
  );
  return root;
}

describe("deployment runtime parity integration", () => {
  test("scores an unverified runtime-sensitive Pages artifact as failed evidence", () => {
    const root = fixture();
    const coverage = analyzeFindingsCoverage(
      root,
      createDetectorContext(root),
      expectationDescriptors,
    );
    expect(coverage.detectors.find((entry) => entry.id === "deployment-runtime-parity")).toEqual({
      id: "deployment-runtime-parity",
      version: 1,
      status: "applied",
      subjects: 1,
    });

    const score = repositoryScoreCommand(root).data.score;
    expect(score?.audits.find((entry) => entry.id === "deployment-runtime-parity")).toMatchObject({
      category: "automation",
      coverageStatus: "applied",
      coverageSubjects: 1,
      scoreModel: "subject-v1",
      subjects: 1,
      failedSubjects: 1,
      score: 0,
    });
  });
});
