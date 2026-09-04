import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { foundationAudit } from "../src/foundation-audit.ts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-foundation-audit-"));
  writeJson(join(root, "package.json"), {
    name: "fixture",
    packageManager: "bun@1.4.0",
    scripts: { lint: "node -e process.exit(0)" },
  });
  writeFileSync(join(root, "bun.lock"), "fixture\n");
  return root;
}

function installEnvironment(root: string, track = "latest-stable"): void {
  writeFileSync(
    join(root, ".repository-environment.toml"),
    `schema_version = 1\ntrack = "${track}"\n`,
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "codex-environment.sh"),
    '#!/usr/bin/env bash\ncase "${1:-}" in\n  "setup") ;;\n  "maintenance") ;;\nesac\n',
  );
}

function installTooling(root: string, requiredCapabilities = ["lint"]): void {
  writeJson(join(root, ".coding-tooling.json"), {
    schemaVersion: 1,
    profile: "repository-foundation-v1",
    requiredCapabilities,
    capabilityCommands: {
      ".": {
        lint: ["node", "-e", "process.exit(0)"],
      },
    },
  });
}

function installConventions(root: string): void {
  writeJson(join(root, "conventions.json"), {
    schemaVersion: 1,
    registry: "coding-agent-conventions",
    modules: ["base"],
  });
  mkdirSync(join(root, ".conventions"), { recursive: true });
  const index = "# Installed conventions\n";
  writeFileSync(join(root, ".conventions", "index.md"), index);
  writeJson(join(root, "conventions.lock.json"), {
    schemaVersion: 1,
    sourceRevision: "fixture-revision",
    requestedModules: ["base"],
    resolvedModules: ["base"],
    files: { "index.md": hash(index) },
  });
}

function installRenovate(root: string): void {
  writeJson(join(root, "renovate.json"), {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: ["github>moritzbrantner/coding-agent-conventions"],
  });
}

function statuses(result: ReturnType<typeof foundationAudit>): Record<string, string> {
  const components = result.data.components as Record<string, { status: string }>;
  return Object.fromEntries(
    Object.entries(components).map(([name, value]) => [name, value.status]),
  );
}

describe("foundation audit", () => {
  test("classifies missing foundation pieces without invoking repository checks", () => {
    const root = repository();

    const result = foundationAudit(root);

    expect(result.operation).toBe("foundation");
    expect(result.status).toBe("failed");
    expect(statuses(result)).toEqual({
      environment: "missing",
      tooling: "missing",
      commands: "missing",
      conventions: "missing",
      renovate: "missing",
    });
  });

  test("accepts a mechanically complete foundation and reports resolved commands", () => {
    const root = repository();
    installEnvironment(root);
    installTooling(root);
    installConventions(root);
    installRenovate(root);

    const result = foundationAudit(root);

    expect(result.status).toBe("passed");
    expect(statuses(result)).toEqual({
      environment: "adopted",
      tooling: "adopted",
      commands: "adopted",
      conventions: "adopted",
      renovate: "adopted",
    });
    const commands = (result.data.components as Record<string, { commands?: unknown }>).commands
      .commands as Array<{
      capability: string;
      command: string[];
      source: string;
    }>;
    expect(commands).toContainEqual(
      expect.objectContaining({
        capability: "lint",
        command: ["node", "-e", "process.exit(0)"],
        source: "configured",
      }),
    );
  });

  test("fails deterministic structural drift without depending on installed runtimes", () => {
    const root = repository();
    installEnvironment(root, "floating");
    installTooling(root);
    installConventions(root);
    installRenovate(root);

    const result = foundationAudit(root);

    expect(result.status).toBe("failed");
    expect(statuses(result).environment).toBe("invalid");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "foundation-environment-track-invalid",
    );
  });

  test("reports unsupported Renovate formats distinctly", () => {
    const root = repository();
    installEnvironment(root);
    installTooling(root);
    installConventions(root);
    writeFileSync(
      join(root, "renovate.json5"),
      `{ extends: ["github>moritzbrantner/coding-agent-conventions"] }\n`,
    );

    const result = foundationAudit(root);

    expect(result.status).toBe("unavailable");
    expect(statuses(result).renovate).toBe("unsupported");
  });

  test("fails when a required capability has no repository-owned command", () => {
    const root = repository();
    installEnvironment(root);
    installTooling(root, ["typecheck"]);
    installConventions(root);
    installRenovate(root);

    const result = foundationAudit(root);

    expect(result.status).toBe("failed");
    expect(statuses(result).commands).toBe("invalid");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "foundation-required-capability-unresolved",
    );
  });
});
