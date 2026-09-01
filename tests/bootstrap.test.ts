import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  bootstrapRepository,
  repositoryFoundationRecommendation,
} from "../src/bootstrap.ts";

function makeRepository(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), "coding-tooling-bootstrap-"));
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("repository foundation bootstrap", () => {
  test("recommends technology-specific conventions for a mixed Rust React template", () => {
    const root = makeRepository("mixed-template");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "mixed-template",
          scripts: {
            "format:check": "oxfmt --check .",
            lint: "oxlint .",
            typecheck: "tsc --noEmit",
            build: "vite build",
            test: "vitest run",
          },
          dependencies: {
            react: "1.0.0",
            "@tanstack/react-query": "1.0.0",
            "@moritzbrantner/ui": "1.0.0",
          },
          devDependencies: {
            vite: "1.0.0",
            vitest: "1.0.0",
            "@playwright/test": "1.0.0",
            "@testing-library/react": "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "mixed"\nversion = "0.1.0"\n');
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");

    const recommendation = repositoryFoundationRecommendation(root);

    expect(recommendation.modules).toEqual(
      expect.arrayContaining([
        "dependencies",
        "dockerfile",
        "environment",
        "git",
        "moritzbrantner-ui",
        "playwright",
        "react",
        "rust",
        "tanstack-query",
        "template-authoring",
        "testing-library",
        "typescript",
        "ui",
        "vite",
        "vitest",
      ]),
    );
    expect(recommendation.config.profile).toBe("repository-foundation-v1");
    expect(recommendation.config.requiredCapabilities).toEqual([
      "format:check",
      "lint",
      "typecheck",
      "build",
      "test:unit",
    ]);
    expect(recommendation.config.optionalCapabilities).toEqual(
      expect.arrayContaining([
        "test:integration",
        "test:e2e",
        "test:e2e:smoke",
        "test:accessibility",
        "benchmark:smoke",
        "template:smoke",
      ]),
    );
  });

  test("keeps a plain Rust library baseline focused", () => {
    const root = makeRepository("geometry-kernel");
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "geometry-kernel"\nversion = "0.1.0"\n');

    const recommendation = repositoryFoundationRecommendation(root);

    expect(recommendation.modules).toEqual(["environment", "git", "rust"]);
    expect(recommendation.config.requiredCapabilities).toEqual([
      "format:check",
      "lint",
      "build",
      "test:unit",
    ]);
    expect(recommendation.config.tiers?.performance).toEqual(["benchmark:smoke"]);
  });

  test("does not apply a foundation to an empty repository", () => {
    const root = makeRepository("empty");

    const result = bootstrapRepository("plan", { root });

    expect(result.status).toBe("unavailable");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-components-unavailable" }),
    );
  });
});
