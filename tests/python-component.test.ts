import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { discoverComponents, planChecks } from "../src/core.ts";
import { foundationAudit } from "../src/foundation-audit.ts";

function pythonRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-python-component-"));
  writeFileSync(
    join(root, "pyproject.toml"),
    '[project]\nname = "fixture"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n',
  );
  writeFileSync(
    join(root, ".coding-tooling.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profile: "repository-foundation-v1",
        tiers: { fast: ["test:unit", "benchmark:smoke"] },
        requiredCapabilities: ["test:unit", "benchmark:smoke"],
        capabilityCommands: {
          ".": {
            "test:unit": ["python3", "scripts/validate_schema.py"],
            "benchmark:smoke": [
              "python3",
              "scripts/validate_schema.py",
              "--evidence",
              ".artifacts/performance-evidence/contract-validation.json",
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("Python repository components", () => {
  test("discovers a pyproject repository as a first-class component", () => {
    const root = pythonRepository();

    expect(discoverComponents(root)).toEqual([
      expect.objectContaining({
        path: ".",
        kind: "python",
        technologies: ["python"],
        capabilities: {},
      }),
    ]);
  });

  test("attaches explicit capability commands to the Python component", () => {
    const root = pythonRepository();

    const plan = planChecks({ root, tier: "fast" });

    expect(plan.missing).toEqual([]);
    expect(plan.checks).toEqual([
      expect.objectContaining({
        capability: "test:unit",
        path: ".",
        command: ["python3", "scripts/validate_schema.py"],
      }),
      expect.objectContaining({
        capability: "benchmark:smoke",
        path: ".",
        command: [
          "python3",
          "scripts/validate_schema.py",
          "--evidence",
          ".artifacts/performance-evidence/contract-validation.json",
        ],
      }),
    ]);
  });

  test("foundation audit treats explicit Python commands as adopted rather than unsupported", () => {
    const root = pythonRepository();

    const result = foundationAudit(root);
    const components = result.data.components as Record<string, { status: string }>;

    expect(components.commands?.status).toBe("adopted");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "foundation-components-unsupported",
    );
  });
});
