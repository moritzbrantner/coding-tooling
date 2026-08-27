import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { auditDependencies } from "../src/dependency-audit.ts";

function repository(
  config: Record<string, unknown>,
  patches: Array<{ package: string; git: string }> = [],
): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-dependency-audit-"));
  writeFileSync(join(root, ".coding-tooling.dependencies.json"), JSON.stringify(config));
  writeFileSync(
    join(root, ".coding-tooling.source-deps.json"),
    JSON.stringify({ schemaVersion: 2, cargo: { localOnly: true, patches } }),
  );
  return root;
}

function baseConfig(layer: "foundation" | "domain" | "adapter" | "application" | "tooling") {
  return {
    schemaVersion: 1,
    repository: { name: "example/current", layer },
    dependencies: [] as Array<Record<string, unknown>>,
  };
}

describe("dependency architecture audit", () => {
  test("fails malformed configuration without throwing", () => {
    const root = repository({ schemaVersion: 1 });

    const result = auditDependencies(root);
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("invalid-dependency-config");
  });

  test("rejects sideways domain implementation dependencies", () => {
    const config = baseConfig("domain");
    config.dependencies.push({
      repository: "example/nlp-stack",
      layer: "domain",
      relation: "capability",
    });
    const root = repository(config, [
      { package: "example-transcripts", git: "https://github.com/example/nlp-stack.git" },
    ]);

    const result = auditDependencies(root);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "domain-sideways-dependency",
    );
  });

  test("allows explicit adapter relationships between domains", () => {
    const config = baseConfig("domain");
    config.dependencies.push({
      repository: "example/scenedetect",
      layer: "domain",
      relation: "adapter",
    });
    const root = repository(config, [
      { package: "scene-core", git: "https://github.com/example/scenedetect.git" },
    ]);

    const result = auditDependencies(root);
    expect(result.status).toBe("passed");
    expect(result.data.findings).toEqual([]);
  });

  test("warns when an application source workspace knows too much upstream topology", () => {
    const config = {
      ...baseConfig("application"),
      maxPackagesPerSourceRepository: 2,
      dependencies: [
        { repository: "example/visual-analysis", layer: "domain", relation: "capability" },
      ],
    };
    const patches = ["core", "io", "detection"].map((name) => ({
      package: `visual-${name}`,
      git: "https://github.com/example/visual-analysis.git",
    }));
    const root = repository(config, patches);

    const normal = auditDependencies(root);
    expect(normal.status).toBe("passed");
    expect(normal.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "capability-topology-leak",
    );

    const strict = auditDependencies(root, undefined, true);
    expect(strict.status).toBe("failed");
  });

  test("rejects legacy source owners and split canonical package ownership", () => {
    const config = {
      ...baseConfig("application"),
      dependencies: [
        { repository: "example/rust-packages", layer: "domain", relation: "capability" },
      ],
      legacyRepositories: { "example/rust-packages": "example/visual-analysis" },
      ownership: [
        {
          package: "visual-core",
          sourceRepository: "example/visual-analysis",
          releaseRepository: "example/rust-packages",
        },
      ],
    };
    const root = repository(config, [
      { package: "visual-core", git: "https://github.com/example/rust-packages.git" },
    ]);

    const result = auditDependencies(root);
    expect(result.status).toBe("failed");
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("legacy-source-repository");
    expect(codes).toContain("split-package-ownership");
  });

  test("rejects declared repository dependency cycles", () => {
    const config = {
      ...baseConfig("application"),
      graph: {
        "example/a": ["example/b"],
        "example/b": ["example/c"],
        "example/c": ["example/a"],
      },
    };
    const root = repository(config);

    const result = auditDependencies(root);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "repository-dependency-cycle",
    );
  });
});
