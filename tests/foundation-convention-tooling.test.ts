import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { foundationAudit } from "../src/foundation-audit.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function repository(
  devDependencies?: Record<string, string>,
  lintScript: string | null = "bunx oxlint@1.81.0 .",
  configureLint = true,
  includeTs005Configuration = true,
): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-foundation-convention-tooling-"));
  writeJson(join(root, "package.json"), {
    name: "rect-like-fixture",
    packageManager: "bun@1.4.0",
    scripts: lintScript ? { lint: lintScript } : {},
    ...(devDependencies ? { devDependencies } : {}),
  });
  writeFileSync(join(root, "bun.lock"), "fixture\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  installEnvironment(root);
  installTooling(root, configureLint);
  installTypeScriptConventions(root, includeTs005Configuration);
  installRenovate(root);
  return root;
}

function installEnvironment(root: string): void {
  writeFileSync(
    join(root, ".repository-environment.toml"),
    'schema_version = 1\ntrack = "latest-stable"\n',
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "codex-environment.sh"),
    '#!/usr/bin/env bash\ncase "${1:-}" in\n  "setup") ;;\n  "maintenance") ;;\nesac\n',
  );
}

function installTooling(root: string, configureLint: boolean): void {
  writeJson(join(root, ".coding-tooling.json"), {
    schemaVersion: 1,
    profile: "repository-foundation-v1",
    requiredCapabilities: configureLint ? ["lint"] : [],
    ...(configureLint
      ? {
          capabilityCommands: {
            ".": {
              lint: ["bun", "run", "lint"],
            },
          },
        }
      : {}),
  });
}

function installTypeScriptConventions(root: string, includeTs005Configuration: boolean): void {
  writeJson(join(root, "conventions.json"), {
    schemaVersion: 1,
    registry: "coding-agent-conventions",
    modules: ["typescript"],
  });

  const configurationManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      configurations: [
        {
          rule: "TS-003",
          path: "modules/typescript/technologies/typescript/TS-003.oxlint.json",
          tool: "oxlint",
          capability: "lint",
          module: "typescript",
        },
        ...(includeTs005Configuration
          ? [
              {
                rule: "TS-005",
                path: "modules/typescript/technologies/typescript/TS-005.oxlint.json",
                tool: "oxlint",
                capability: "lint",
                module: "typescript",
              },
            ]
          : []),
      ],
    },
    null,
    2,
  )}\n`;
  const ts003Config = `${JSON.stringify(
    {
      rules: {
        "typescript/consistent-type-definitions": ["error", "type"],
      },
    },
    null,
    2,
  )}\n`;
  const ts005Config = `${JSON.stringify(
    {
      rules: {
        "typescript/switch-exhaustiveness-check": "error",
      },
    },
    null,
    2,
  )}\n`;
  const files: Record<string, string> = {
    "index.md": "# Installed conventions\n",
    "configurations.json": configurationManifest,
    "modules/typescript/technologies/typescript/TS-003.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        ruleId: "TS-003",
        enforcement: {
          kind: "oxlint",
          technologies: ["typescript"],
          config: {
            rules: {
              "typescript/consistent-type-definitions": ["error", "type"],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "modules/typescript/technologies/typescript/TS-003.oxlint.json": ts003Config,
    "modules/typescript/technologies/typescript/TS-005.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        ruleId: "TS-005",
        enforcement: {
          kind: "oxlint",
          technologies: ["typescript"],
          config: {
            options: {
              typeAware: true,
            },
            rules: {
              "typescript/switch-exhaustiveness-check": "error",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    ...(includeTs005Configuration
      ? { "modules/typescript/technologies/typescript/TS-005.oxlint.json": ts005Config }
      : {}),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, ".conventions", relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  writeJson(join(root, "conventions.lock.json"), {
    schemaVersion: 1,
    sourceRevision: "fixture-revision",
    requestedModules: ["typescript"],
    resolvedModules: ["typescript"],
    files: Object.fromEntries(
      Object.entries(files).map(([relativePath, content]) => [relativePath, hash(content)]),
    ),
  });
}

function installRenovate(root: string): void {
  writeJson(join(root, "renovate.json"), {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: ["github>moritzbrantner/coding-agent-conventions"],
  });
}

type ExecutableTooling = {
  status: string;
  requiredExecutables: Array<{
    name: string;
    status: string;
    rules: string[];
    declarations: Array<{ path: string; section: string; version: string }>;
  }>;
};

function executableTooling(result: ReturnType<typeof foundationAudit>): ExecutableTooling {
  const components = result.data.components as Record<
    string,
    { status: string; executableTooling?: ExecutableTooling }
  >;
  return components.conventions!.executableTooling!;
}

describe("foundation convention executable tooling", () => {
  test("does not treat versioned bunx scripts as declared convention executables", () => {
    const result = foundationAudit(repository());
    const tooling = executableTooling(result);

    expect(result.status).toBe("failed");
    expect(tooling.status).toBe("missing");
    expect(tooling.requiredExecutables).toEqual([
      {
        name: "oxlint",
        status: "missing",
        rules: ["TS-003", "TS-005"],
        declarations: [],
      },
      {
        name: "oxlint-tsgolint",
        status: "missing",
        rules: ["TS-005"],
        declarations: [],
      },
    ]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-tool-missing"),
    ).toHaveLength(2);
  });

  test("accepts exact pinned local tooling required by installed conventions", () => {
    const result = foundationAudit(
      repository({
        oxlint: "1.81.0",
        "oxlint-tsgolint": "7.0.2001",
      }),
    );
    const tooling = executableTooling(result);

    expect(result.status).toBe("passed");
    expect(tooling.status).toBe("adopted");
    expect(tooling.requiredExecutables).toEqual([
      {
        name: "oxlint",
        status: "adopted",
        rules: ["TS-003", "TS-005"],
        declarations: [
          {
            path: "package.json",
            section: "devDependencies",
            version: "1.81.0",
          },
        ],
      },
      {
        name: "oxlint-tsgolint",
        status: "adopted",
        rules: ["TS-005"],
        declarations: [
          {
            path: "package.json",
            section: "devDependencies",
            version: "7.0.2001",
          },
        ],
      },
    ]);
  });

  test("reports floating convention executable versions as invalid rather than missing", () => {
    const result = foundationAudit(
      repository({
        oxlint: "^1.81.0",
        "oxlint-tsgolint": "7.0.2001",
      }),
    );
    const tooling = executableTooling(result);

    expect(result.status).toBe("failed");
    expect(tooling.status).toBe("invalid");
    expect(tooling.requiredExecutables.find((item) => item.name === "oxlint")?.status).toBe(
      "invalid",
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "foundation-convention-tool-version-invalid",
        path: "package.json",
      }),
    );
  });

  test("fails closed when the selected lint capability cannot consume installed Oxlint rules", () => {
    const result = foundationAudit(
      repository(
        {
          oxlint: "1.81.0",
          "oxlint-tsgolint": "7.0.2001",
        },
        "eslint . --max-warnings 0",
      ),
    );
    const tooling = executableTooling(result);

    expect(result.status).toBe("failed");
    expect(tooling.status).toBe("invalid");
    expect(tooling.requiredExecutables.map((item) => [item.name, item.status])).toEqual([
      ["oxlint", "adopted"],
      ["oxlint-tsgolint", "adopted"],
    ]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-adapter-unresolved"),
    ).toHaveLength(2);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-tool-missing"),
    ).toHaveLength(0);
  });

  test("fails closed when an applicable convention has no selected capability command", () => {
    const result = foundationAudit(repository(undefined, null, false));
    const tooling = executableTooling(result);

    expect(result.status).toBe("failed");
    expect(tooling.status).toBe("invalid");
    expect(tooling.requiredExecutables.map((item) => [item.name, item.status])).toEqual([
      ["oxlint", "missing"],
      ["oxlint-tsgolint", "missing"],
    ]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-adapter-unresolved"),
    ).toHaveLength(2);
    expect(
      result.diagnostics.filter(
        (item) => item.code === "foundation-required-capability-unresolved",
      ),
    ).toHaveLength(0);
  });

  test("requires type-aware tooling for enforcement-only installed rules", () => {
    const result = foundationAudit(
      repository(
        {
          oxlint: "1.81.0",
        },
        "bunx oxlint@1.81.0 .",
        true,
        false,
      ),
    );
    const tooling = executableTooling(result);

    expect(result.status).toBe("failed");
    expect(tooling.status).toBe("missing");
    expect(tooling.requiredExecutables).toEqual([
      {
        name: "oxlint",
        status: "adopted",
        rules: ["TS-003", "TS-005"],
        declarations: [
          {
            path: "package.json",
            section: "devDependencies",
            version: "1.81.0",
          },
        ],
      },
      {
        name: "oxlint-tsgolint",
        status: "missing",
        rules: ["TS-005"],
        declarations: [],
      },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "foundation-convention-tool-missing" }),
    );
  });
});
