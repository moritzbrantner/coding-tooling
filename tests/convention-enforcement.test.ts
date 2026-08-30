import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { runConventionChecks } from "../src/convention-enforcement.ts";
import { discoverComponents } from "../src/core.ts";

function repository(manifest: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-conventions-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", ...manifest }, null, 2)}\n`,
  );
  mkdirSync(join(root, "src"));
  return root;
}

function enforce(root: string, name: string, enforcement: Record<string, unknown>): void {
  const directory = join(root, ".conventions", "modules", "fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify({ schemaVersion: 1, ruleId: name, enforcement }, null, 2)}\n`,
  );
}

describe("installed convention enforcement", () => {
  test("accepts Bun repositories and rejects conflicting package-manager locks", () => {
    const root = repository({ packageManager: "bun@1.4.0" });
    writeFileSync(join(root, "bun.lock"), "");
    enforce(root, "BUN-001", { kind: "builtin", check: "bun-default" });

    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(join(root, "package-lock.json"), "{}");
    const failed = runConventionChecks(root, discoverComponents(root));
    expect(failed.status).toBe("failed");
    expect(failed.diagnostics[0]?.message).toContain("conflicting lockfile");
  });

  test("requires used environment variables in the nearest .env.example", () => {
    const root = repository();
    writeFileSync(join(root, "src", "config.ts"), "export const value = process.env.API_URL;\n");
    enforce(root, "ENV-003", { kind: "builtin", check: "env-example" });

    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");

    writeFileSync(join(root, ".env.example"), "API_URL=\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
  });

  test("requires Vitest execution kind in filenames and scripts", () => {
    const root = repository({
      scripts: { "test:unit": "vitest run" },
      devDependencies: { vitest: "1" },
    });
    const generic = join(root, "src", "thing.test.ts");
    writeFileSync(generic, "export {};\n");
    enforce(root, "VITEST-001", { kind: "builtin", check: "vitest-kinds" });

    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");

    rmSync(generic);
    writeFileSync(join(root, "src", "thing.unit.test.ts"), "export {};\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
  });
});
