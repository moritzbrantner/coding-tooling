import { createHash } from "node:crypto";
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function foundation(path: string): void {
  writeJson(join(path, "package.json"), {
    name: path.split("/").at(-1),
    packageManager: "bun@1.4.0",
    scripts: { lint: "node -e process.exit(0)" },
  });
  writeFileSync(join(path, "bun.lock"), "fixture\n");
  writeFileSync(
    join(path, ".repository-environment.toml"),
    'schema_version = 1\ntrack = "latest-stable"\n',
  );
  mkdirSync(join(path, "scripts"), { recursive: true });
  writeFileSync(
    join(path, "scripts", "codex-environment.sh"),
    '#!/usr/bin/env bash\ncase "${1:-}" in\n  "setup") ;;\n  "maintenance") ;;\nesac\n',
  );
  writeJson(join(path, ".coding-tooling.json"), {
    schemaVersion: 1,
    profile: "repository-foundation-v1",
    requiredCapabilities: ["lint"],
    capabilityCommands: {
      ".": {
        lint: ["node", "-e", "process.exit(0)"],
      },
    },
  });
  writeJson(join(path, "conventions.json"), {
    schemaVersion: 1,
    registry: "coding-agent-conventions",
    modules: ["base"],
  });
  mkdirSync(join(path, ".conventions"), { recursive: true });
  const index = "# Installed conventions\n";
  writeFileSync(join(path, ".conventions", "index.md"), index);
  writeJson(join(path, "conventions.lock.json"), {
    schemaVersion: 1,
    sourceRevision: "fixture-revision",
    requestedModules: ["base"],
    resolvedModules: ["base"],
    files: { "index.md": hash(index) },
  });
  writeJson(join(path, "renovate.json"), {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: ["github>moritzbrantner/coding-agent-conventions"],
  });
  writeFileSync(join(path, "AGENTS.md"), "# Agents\n");
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
  test("uses the canonical foundation audit and preserves deterministic remediation", () => {
    const fleet = tempRoot("coding-tooling-fleet-");
    const complete = repository(fleet, "complete");
    metadata(complete);
    foundation(complete);

    repository(fleet, "legacy");

    const result = fleetAudit(fleet);
    const repositories = result.data.repositories as Array<{
      name: string;
      missing: string[];
      invalid: string[];
      unsupported: string[];
      remediation: string[];
      foundationAudit: {
        status: string;
        components: Record<string, { status: string }>;
      };
    }>;
    const completeResult = repositories.find((entry) => entry.name === "complete");
    const legacy = repositories.find((entry) => entry.name === "legacy");

    expect(result.status).toBe("failed");
    expect(result.data.repositoryCount).toBe(2);
    expect(result.data.conformingRepositoryCount).toBe(1);
    expect(completeResult?.missing).toEqual([]);
    expect(completeResult?.invalid).toEqual([]);
    expect(completeResult?.unsupported).toEqual([]);
    expect(completeResult?.foundationAudit.status).toBe("passed");
    expect(completeResult?.foundationAudit.components.environment?.status).toBe("adopted");
    expect(completeResult?.foundationAudit.components.commands?.status).toBe("adopted");
    expect(legacy?.missing).toContain("metadata");
    expect(legacy?.missing).toContain("environmentV1");
    expect(legacy?.missing).not.toContain("workflows");
    expect(legacy?.invalid).toEqual([]);
    expect(legacy?.remediation.some((entry) => entry.includes("boring-foundation-v1"))).toBe(true);
    expect(legacy?.remediation.some((entry) => entry.includes("scaffold-v2"))).toBe(false);
  });

  test("surfaces invalid foundation state separately from missing state", () => {
    const fleet = tempRoot("coding-tooling-fleet-invalid-");
    const target = repository(fleet, "target");
    metadata(target);
    foundation(target);
    writeFileSync(
      join(target, ".repository-environment.toml"),
      'schema_version = 1\ntrack = "floating"\n',
    );

    const result = fleetAudit(fleet);
    const repositories = result.data.repositories as Array<{
      name: string;
      missing: string[];
      invalid: string[];
      foundationAudit: { status: string };
    }>;
    const targetResult = repositories.find((entry) => entry.name === "target");

    expect(result.status).toBe("failed");
    expect(targetResult?.missing).not.toContain("environmentV1");
    expect(targetResult?.invalid).toContain("environmentV1");
    expect(targetResult?.foundationAudit.status).toBe("failed");
  });
});
