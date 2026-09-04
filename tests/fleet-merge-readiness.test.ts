import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { fleetAudit } from "../src/repository-metadata.ts";

function fleetRepository(name: string): { fleet: string; repository: string; id: string } {
  const fleet = mkdtempSync(join(tmpdir(), "coding-tooling-fleet-merge-"));
  const repository = join(fleet, name);
  const id = `moritzbrantner/${name}`;
  mkdirSync(join(repository, ".git"), { recursive: true });
  writeFileSync(
    join(repository, ".repository.toml"),
    `schema_version = 1
id = "${id}"
kind = "library"
status = "active"
depends_on = []
consumed_by = []
supersedes = []
replaced_by = []
`,
  );
  return { fleet, repository, id };
}

describe("fleet trusted merge readiness", () => {
  test("does not let remote evidence self-grant readiness over an incomplete foundation", () => {
    const { fleet, id } = fleetRepository("incomplete");
    const result = fleetAudit(fleet, {
      mergeEvidence: {
        [id]: {
          hostedValidation: "verified",
          protectedDefaultBranch: "verified",
          requiredChecks: ["Validate"],
        },
      },
    });
    const repository = (result.data.repositories as Array<Record<string, unknown>>)[0] as {
      mergeReadiness: {
        classification: string;
        blockers: string[];
      };
    };

    expect(repository.mergeReadiness.classification).toBe("not-ready");
    expect(repository.mergeReadiness.blockers).toContain("foundation-not-ready");
  });

  test("discovers local-only source development as stronger local evidence", () => {
    const { fleet, repository: root, id } = fleetRepository("local-only");
    writeFileSync(
      join(root, ".coding-tooling.source-deps.json"),
      JSON.stringify({ schemaVersion: 2, cargo: { localOnly: true, patches: [] } }),
    );

    const result = fleetAudit(fleet, {
      mergeEvidence: {
        [id]: {
          hostedValidation: "verified",
          protectedDefaultBranch: "verified",
          requiredChecks: ["Validate"],
        },
      },
    });
    const repository = (result.data.repositories as Array<Record<string, unknown>>)[0] as {
      mergeReadiness: {
        evidence: { localGateReasons: string[] };
      };
    };

    expect(repository.mergeReadiness.evidence.localGateReasons).toContain("source-development");
  });
});
