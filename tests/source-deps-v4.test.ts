import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { expectedEnvironmentFingerprint } from "../src/environment-fingerprint.ts";
import { readSourceDependencyConfig } from "../src/source-deps.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-source-v4-"));
  mkdirSync(join(root, "source-a"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, packageManager: "bun@1.4.0" })}\n`,
  );
  writeFileSync(
    join(root, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: 4,
        cargo: { repositories: [] },
        javascript: {
          localOnly: true,
          repositories: [
            {
              git: "https://github.com/example/source-a.git",
              rev: "1111111111111111111111111111111111111111",
              localPath: "source-a",
              packages: [{ package: "@example/source-a" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("source dependency schema v4", () => {
  test("normalizes JavaScript repositories into the shared source graph", () => {
    const root = repository();
    const loaded = readSourceDependencyConfig(root);

    expect(loaded.schemaVersion).toBe(4);
    expect(loaded.patches).toEqual([]);
    expect(loaded.sourceRepositories).toEqual([
      {
        ecosystem: "javascript",
        git: "https://github.com/example/source-a.git",
        rev: "1111111111111111111111111111111111111111",
        localPath: "source-a",
        localOnly: true,
        packages: [{ package: "@example/source-a" }],
      },
    ]);
  });

  test("includes JavaScript exact revisions in the source-development fingerprint", () => {
    const root = repository();
    const first = expectedEnvironmentFingerprint(root, "source-development");
    expect(first.status).toBe("passed");
    const firstSources = (first.data.layers as Record<string, { inputs: unknown }>).sources.inputs;
    expect(firstSources).toEqual({
      profile: "source-development",
      mode: "source-development",
      schemaVersion: 4,
      cargoLocalOnly: false,
      javascriptLocalOnly: true,
      repositories: [
        {
          ecosystem: "javascript",
          git: "https://github.com/example/source-a.git",
          rev: "1111111111111111111111111111111111111111",
          localOnly: true,
          packages: [{ package: "@example/source-a" }],
        },
      ],
    });

    const path = join(root, ".coding-tooling.source-deps.json");
    const config = {
      schemaVersion: 4,
      cargo: { repositories: [] },
      javascript: {
        localOnly: true,
        repositories: [
          {
            git: "https://github.com/example/source-a.git",
            rev: "2222222222222222222222222222222222222222",
            localPath: "source-a",
            packages: [{ package: "@example/source-a" }],
          },
        ],
      },
    };
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

    const second = expectedEnvironmentFingerprint(root, "source-development");
    expect(second.status).toBe("passed");
    expect(second.data.fingerprint).not.toBe(first.data.fingerprint);
  });
});
