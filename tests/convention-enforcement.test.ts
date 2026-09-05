import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("accepts exact Bun repositories and rejects conflicting package-manager locks", () => {
    const root = repository({ packageManager: "bun@1.4.0" });
    writeFileSync(join(root, "bun.lock"), "");
    enforce(root, "BUN-001", { kind: "builtin", check: "bun-default" });

    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(join(root, "package-lock.json"), "{}");
    const failed = runConventionChecks(root, discoverComponents(root));
    expect(failed.status).toBe("failed");
    expect(failed.diagnostics[0]?.message).toContain("conflicting lockfile");
  });

  test("requires an exact root Bun packageManager declaration", () => {
    const missing = repository();
    writeFileSync(join(missing, "bun.lock"), "");
    enforce(missing, "BUN-001", { kind: "builtin", check: "bun-default" });
    expect(
      runConventionChecks(missing, discoverComponents(missing)).diagnostics[0]?.message,
    ).toContain("must declare an exact packageManager");

    const floating = repository({ packageManager: "bun@^1.4.0" });
    writeFileSync(join(floating, "bun.lock"), "");
    enforce(floating, "BUN-001", { kind: "builtin", check: "bun-default" });
    expect(
      runConventionChecks(floating, discoverComponents(floating)).diagnostics[0]?.message,
    ).toContain("must be an exact Bun version");
  });

  test("requires used environment variables in the nearest .env.example", () => {
    const root = repository();
    writeFileSync(join(root, "src", "config.ts"), "export const value = process.env.API_URL;\n");
    enforce(root, "ENV-003", { kind: "builtin", check: "env-example" });

    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");

    writeFileSync(join(root, ".env.example"), "# API_URL=\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
  });

  test("does not treat ambient host and CI variables as repository environment contract", () => {
    const root = repository();
    writeFileSync(
      join(root, "src", "ambient.ts"),
      "export const ci = process.env.CI;\nexport const home = process.env.HOME;\nexport const nodeEnv = process.env.NODE_ENV;\nexport const nextPhase = process.env.NEXT_PHASE;\n",
    );
    writeFileSync(
      join(root, "src", "ambient.rs"),
      'fn cache() { let _ = std::env::var_os("XDG_CACHE_HOME"); }\n',
    );
    enforce(root, "ENV-003", { kind: "builtin", check: "env-example" });

    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(
      join(root, "src", "ambient.ts"),
      "export const ci = process.env.CI;\nexport const api = process.env.API_URL;\n",
    );
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");
  });

  test("requires actionable TODO syntax and rejects FIXME", () => {
    const root = repository();
    const source = join(root, "src", "thing.ts");
    enforce(root, "REPO-010", { kind: "builtin", check: "todo-format" });

    writeFileSync(source, `export const url = "https://example.test/TODO";\n`);
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(source, "// TODO make retry limit configurable\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");

    writeFileSync(source, "// TODO: make retry limit configurable\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(source, "// TODO(#123): make retry limit configurable\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(source, "// FIXME: retry limit\n");
    const failed = runConventionChecks(root, discoverComponents(root));
    expect(failed.status).toBe("failed");
    expect(failed.diagnostics[0]?.message).toContain("instead of FIXME");
  });

  test("requires portable UTF-8 LF text", () => {
    const root = repository();
    const source = join(root, "src", "thing.ts");
    enforce(root, "REP-011", { kind: "builtin", check: "text-hygiene" });

    writeFileSync(source, "export const value = 1;\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");

    writeFileSync(source, "export const value = 1;\r\n");
    const failed = runConventionChecks(root, discoverComponents(root));
    expect(failed.status).toBe("failed");
    expect(failed.diagnostics[0]?.message).toContain("use LF line endings");
  });

  test("requires immutable external CI action revisions", () => {
    const root = repository();
    const workflows = join(root, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    const workflow = join(workflows, "validate.yml");
    enforce(root, "GIT-004", { kind: "builtin", check: "ci-action-pins" });

    writeFileSync(workflow, "steps:\n  - uses: actions/checkout@v6\n");
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");

    writeFileSync(
      workflow,
      "steps:\n  - uses: actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8 # v6.0.1\n",
    );
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
  });

  test("rejects symlinks that escape the repository", () => {
    const root = repository();
    const link = join(root, "src", "outside");
    enforce(root, "REPO-012", { kind: "builtin", check: "symlink-boundaries" });

    symlinkSync(join(tmpdir(), "outside-target"), link);
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("failed");

    rmSync(link);
    writeFileSync(join(root, "src", "inside.ts"), "export {};\n");
    symlinkSync("inside.ts", link);
    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
  });

  test("rejects case-colliding repository paths", () => {
    const root = repository();
    enforce(root, "REPO-013", { kind: "builtin", check: "case-portability" });
    writeFileSync(join(root, "src", "User.ts"), "export {};\n");
    writeFileSync(join(root, "src", "user.ts"), "export {};\n");

    const caseVariants = readdirSync(join(root, "src")).filter(
      (name) => name.toLowerCase() === "user.ts",
    );
    if (caseVariants.length < 2) return;

    const failed = runConventionChecks(root, discoverComponents(root));
    expect(failed.status).toBe("failed");
    expect(failed.diagnostics[0]?.message).toContain("case-insensitive filesystems");
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
