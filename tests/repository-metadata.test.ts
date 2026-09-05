import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

function metadata(
  path: string,
  options: { status?: string; replacedBy?: string[] } = {},
): void {
  const status = options.status ?? "active";
  const replacedBy = options.replacedBy ?? [];
  writeFileSync(
    join(path, ".repository.toml"),
    `schema_version = 1
id = "moritzbrantner/${basename(path)}"
kind = "library"
status = "${status}"
depends_on = ["moritzbrantner/coding-tooling"]
consumed_by = []
supersedes = []
replaced_by = [${replacedBy.map((entry) => JSON.stringify(entry)).join(", ")}]
`,
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
  test("reports authoritative foundation gaps and deterministic remediation", () => {
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
      foundationAudit: {
        status: string;
        missing: string[];
        blockers: Array<{ component: string; status: string }>;
      };
    }>;
    const completeResult = repositories.find((entry) => entry.name === "complete");
    const legacy = repositories.find((entry) => entry.name === "legacy");

    expect(result.status).toBe("failed");
    expect(result.data.repositoryCount).toBe(2);
    expect(completeResult?.missing).toEqual([]);
    expect(legacy?.missing).toContain("metadata");
    expect(legacy?.missing).toContain("environmentV1");
    expect(legacy?.missing).not.toContain("workflows");
    expect(legacy?.foundationAudit.missing).toEqual([
      "commands",
      "conventions",
      "environment",
      "renovate",
      "tooling",
    ]);
    expect(legacy?.foundationAudit.blockers).toEqual([]);
    expect(legacy?.remediation.some((entry) => entry.includes("boring-foundation-v1"))).toBe(true);
    expect(legacy?.remediation.some((entry) => entry.includes("scaffold-v2"))).toBe(false);
    expect(completeResult?.foundationAudit.blockers.length).toBeGreaterThan(0);
    expect(
      completeResult?.remediation.some((entry) => entry.includes("foundation audit --root")),
    ).toBe(true);
  });

  test("does not revive repositories that are intentionally retiring or archived", () => {
    const fleet = tempRoot("coding-tooling-fleet-retired-");
    const retiring = repository(fleet, "retiring");
    metadata(retiring, {
      status: "retiring",
      replacedBy: ["moritzbrantner/coding-agent-skills"],
    });
    const archived = repository(fleet, "archived");
    metadata(archived, { status: "archived" });

    const result = fleetAudit(fleet);
    const repositories = result.data.repositories as Array<{
      name: string;
      missing: string[];
      remediation: string[];
      lifecycle: { foundationRequired: boolean; blockers: Array<{ code: string }> };
      foundationAudit: { missing: string[]; blockers: unknown[]; observedMissing: string[] };
    }>;
    const retiringResult = repositories.find((entry) => entry.name === "retiring");
    const archivedResult = repositories.find((entry) => entry.name === "archived");

    expect(result.status).toBe("passed");
    expect(retiringResult?.lifecycle.foundationRequired).toBe(false);
    expect(archivedResult?.lifecycle.foundationRequired).toBe(false);
    expect(retiringResult?.missing).toEqual([]);
    expect(archivedResult?.missing).toEqual([]);
    expect(retiringResult?.foundationAudit.missing).toEqual([]);
    expect(archivedResult?.foundationAudit.blockers).toEqual([]);
    expect(retiringResult?.foundationAudit.observedMissing).toContain("renovate");
    expect(retiringResult?.remediation.some((entry) => entry.includes("boring-foundation-v1"))).toBe(
      false,
    );
  });

  test("requires a deterministic migration target while a repository is retiring", () => {
    const fleet = tempRoot("coding-tooling-fleet-retiring-target-");
    const retiring = repository(fleet, "retiring");
    metadata(retiring, { status: "retiring" });

    const result = fleetAudit(fleet);
    const repositories = result.data.repositories as Array<{
      name: string;
      remediation: string[];
      lifecycle: { blockers: Array<{ code: string }> };
    }>;
    const retiringResult = repositories.find((entry) => entry.name === "retiring");

    expect(result.status).toBe("failed");
    expect(retiringResult?.lifecycle.blockers).toContainEqual(
      expect.objectContaining({ code: "repository-retiring-without-replacement" }),
    );
    expect(retiringResult?.remediation.some((entry) => entry.includes(".repository.toml"))).toBe(
      true,
    );
  });
});
