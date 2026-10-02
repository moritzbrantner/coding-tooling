import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { workflowProfileAudit } from "../src/workflow-profile-audit.ts";

const digest = `sha256:${"a".repeat(64)}`;

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-workflow-profile-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function declaration(root: string, overrides: Record<string, unknown> = {}): void {
  writeJson(join(root, ".github", "workflow-profile.json"), {
    schemaVersion: 1,
    catalog: "workflow-profiles-v1",
    catalogDigest: digest,
    profile: "application",
    enabledRoles: ["validate", "pages"],
    workflows: {
      validate: ".github/workflows/validate.yml",
      pages: ".github/workflows/pages.yml",
    },
    exceptions: [],
    ...overrides,
  });
}

function workflow(root: string, name: string): void {
  writeFileSync(join(root, ".github", "workflows", name), "name: Fixture\n");
}

describe("workflow profile audit", () => {
  test("passes a repository whose workflow topology matches the declaration", () => {
    const root = repository();
    declaration(root);
    workflow(root, "validate.yml");
    workflow(root, "pages.yml");

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("passed");
    expect(result.data.summary).toEqual({
      expected: 2,
      exceptions: 0,
      actual: 2,
      missing: 0,
      missingExceptions: 0,
      unexpected: 0,
    });
  });

  test("reports a missing canonical workflow", () => {
    const root = repository();
    declaration(root);
    workflow(root, "validate.yml");

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("failed");
    expect(result.data.missingWorkflows).toEqual([".github/workflows/pages.yml"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workflow-profile-workflow-missing" }),
    );
  });

  test("reports an undeclared extra workflow", () => {
    const root = repository();
    declaration(root);
    workflow(root, "validate.yml");
    workflow(root, "pages.yml");
    workflow(root, "temporary-repair.yml");

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("failed");
    expect(result.data.unexpectedWorkflows).toEqual([".github/workflows/temporary-repair.yml"]);
  });

  test("allows an explicit reasoned exception", () => {
    const root = repository();
    declaration(root, {
      exceptions: [
        {
          path: ".github/workflows/security.yml",
          reason: "Separate write permission boundary for security publication",
        },
      ],
    });
    workflow(root, "validate.yml");
    workflow(root, "pages.yml");
    workflow(root, "security.yml");

    expect(workflowProfileAudit(root).status).toBe("passed");
  });

  test("reports stale exceptions whose workflow is absent", () => {
    const root = repository();
    declaration(root, {
      exceptions: [
        {
          path: ".github/workflows/security.yml",
          reason: "Separate security publication permission boundary",
        },
      ],
    });
    workflow(root, "validate.yml");
    workflow(root, "pages.yml");

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("failed");
    expect(result.data.missingExceptionWorkflows).toEqual([".github/workflows/security.yml"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "workflow-profile-exception-workflow-missing",
      }),
    );
  });

  test("returns a structured failure when the workflows path is not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-workflow-profile-invalid-"));
    mkdirSync(join(root, ".github"), { recursive: true });
    declaration(root, {
      enabledRoles: ["validate"],
      workflows: { validate: ".github/workflows/validate.yml" },
    });
    writeFileSync(join(root, ".github", "workflows"), "not a directory\n");

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "workflow-profile-workflows-path-invalid",
        path: ".github/workflows",
      }),
    );
  });

  test("fails closed on malformed declarations", () => {
    const root = repository();
    declaration(root, {
      catalogDigest: "main",
      enabledRoles: ["validate", "validate"],
      workflows: { validate: "validate.yml" },
      exceptions: [{ path: ".github/workflows/x.yml", reason: "short" }],
    });

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "workflow-profile-catalog-digest-invalid",
        "workflow-profile-enabled-roles-invalid",
        "workflow-profile-workflow-path-invalid",
        "workflow-profile-exception-invalid",
      ]),
    );
  });

  test("fails when the declaration is absent", () => {
    const root = repository();

    const result = workflowProfileAudit(root);

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workflow-profile-declaration-missing" }),
    );
  });
});
