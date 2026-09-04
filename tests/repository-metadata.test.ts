import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { fleetAudit, readRepositoryMetadata } from "../src/repository-metadata.ts";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function repository(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
}

function metadata(path: string, body = ""): void {
  writeFileSync(
    join(path, ".repository.toml"),
    `schema_version = 1
id = "moritzbrantner/${path.split("/").at(-1)}"
kind = "library"
status = "active"
depends_on = ["moritzbrantner/coding-tooling"]
consumed_by = []
supersedes = []
replaced_by = []
${body}`,
  );
}

describe("repository metadata", () => {
  test("parses lifecycle and relationship metadata", () => {
    const root = tempRoot("coding-tooling-metadata-");
    metadata(root);

    const result = readRepositoryMetadata(root);

    expect(result.diagnostics).toEqual([]);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        kind: "library",
        status: "active",
        dependsOn: ["moritzbrantner/coding-tooling"],
      }),
    );
  });

  test("rejects invalid repository relationships", () => {
    const root = tempRoot("coding-tooling-metadata-invalid-");
    writeFileSync(
      join(root, ".repository.toml"),
      `schema_version = 1
id = "moritzbrantner/example"
kind = "library"
status = "active"
depends_on = ["not-a-repository"]
`,
    );

    const result = readRepositoryMetadata(root);

    expect(result.metadata).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-metadata-relation-invalid" }),
    );
  });
});

describe("fleet audit", () => {
  test("reports foundation gaps and deterministic remediation", () => {
    const fleet = tempRoot("coding-tooling-fleet-");
    const complete = repository(fleet, "complete");
    metadata(complete);
    writeFileSync(join(complete, ".repository-environment.toml"), "schema_version = 1\n");
    writeFileSync(join(complete, ".coding-tooling.json"), '{"schemaVersion":1}\n');
    writeFileSync(join(complete, "conventions.json"), '{"schemaVersion":1}\n');
    writeFileSync(join(complete, "conventions.lock.json"), '{"schemaVersion":1}\n');
    writeFileSync(join(complete, "renovate.json"), "{}\n");
    writeFileSync(join(complete, "AGENTS.md"), "# Agents\n");

    repository(fleet, "legacy");

    const result = fleetAudit(fleet);
    const repositories = result.data.repositories as Array<{
      name: string;
      missing: string[];
      remediation: string[];
    }>;
    const completeResult = repositories.find((entry) => entry.name === "complete");
    const legacy = repositories.find((entry) => entry.name === "legacy");

    expect(result.status).toBe("failed");
    expect(result.data.repositoryCount).toBe(2);
    expect(completeResult?.missing).toEqual([]);
    expect(legacy?.missing).toContain("metadata");
    expect(legacy?.missing).toContain("environmentV1");
    expect(legacy?.missing).not.toContain("workflows");
    expect(
      legacy?.remediation.some((entry) => entry.includes("boring-foundation-v1")),
    ).toBe(true);
    expect(legacy?.remediation.some((entry) => entry.includes("scaffold-v2"))).toBe(false);
  });
});
