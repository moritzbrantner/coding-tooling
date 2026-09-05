import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyConventionConfigurations,
  composeToolConfiguration,
} from "../src/convention-config.ts";
import { conventionRegistryCommand } from "../src/convention-registry.ts";
import { discoverComponents, planChecks } from "../src/core.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

function conventionSource(): string {
  const root = workspace("convention-config-source-");
  write(root, "README.md", "# Conventions\n");
  write(root, "principles/README.md", "## PRINCIPLE-001 — Be explicit\n");
  write(root, "conventions/README.md", "# General conventions\n");
  write(
    root,
    "technologies/typescript/README.md",
    "## TS-003 — Prefer type over interface\n\n- Prefer type aliases.\n",
  );
  write(
    root,
    "technologies/typescript/TS-003.oxlint.json",
    `${JSON.stringify(
      {
        rules: { "typescript/consistent-type-definitions": ["error", "type"] },
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    "registry/registry.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        modules: {
          base: { sources: ["principles/README.md"], dependencies: [] },
          typescript: {
            sources: ["technologies/typescript/README.md"],
            assets: ["technologies/typescript/TS-003.oxlint.json"],
            configurations: [
              {
                rule: "TS-003",
                path: "technologies/typescript/TS-003.oxlint.json",
                tool: "oxlint",
                capability: "lint",
              },
            ],
            dependencies: ["base"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function typescriptConsumer(): string {
  const root = workspace("convention-config-consumer-");
  write(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "consumer",
        scripts: { lint: "oxlint .", "format:check": "oxfmt --check ." },
      },
      null,
      2,
    )}\n`,
  );
  write(root, "bun.lock", "");
  write(root, "tsconfig.json", "{}\n");
  write(
    root,
    ".oxlintrc.json",
    `${JSON.stringify({ categories: { correctness: "error" } }, null, 2)}\n`,
  );
  write(root, ".oxfmtrc.json", `${JSON.stringify({ semi: true }, null, 2)}\n`);
  write(
    root,
    ".coding-tooling.json",
    `${JSON.stringify({ schemaVersion: 1, tiers: { lintOnly: ["lint"] } }, null, 2)}\n`,
  );
  return root;
}

describe("convention tooling configuration", () => {
  test("installs companion assets and projects TS-003 into the normal lint capability", () => {
    const source = conventionSource();
    const target = typescriptConsumer();
    try {
      const init = conventionRegistryCommand("init", ["typescript"], {
        root: target,
        conventionsRoot: source,
      });
      expect(init.status).toBe("passed");
      expect(
        existsSync(
          join(
            target,
            ".conventions/modules/typescript/technologies/typescript/TS-003.oxlint.json",
          ),
        ),
      ).toBe(true);
      expect(readFileSync(join(target, ".conventions/index.md"), "utf8")).toContain(
        "## Companion configuration assets",
      );

      const metadata = JSON.parse(
        readFileSync(join(target, ".conventions/configurations.json"), "utf8"),
      );
      expect(metadata.configurations).toHaveLength(1);
      expect(metadata.configurations[0].rule).toBe("TS-003");

      const plan = planChecks({ root: target, tier: "lintOnly" });
      expect(plan.checks).toHaveLength(1);
      const command = plan.checks[0]!.command;
      expect(command.slice(0, 4)).toEqual(["bun", "run", "lint", "--config"]);
      expect(command).toContain("--disable-nested-config");
      expect(command).not.toContain("--");
      const configPath = command[command.indexOf("--config") + 1]!;
      const effective = JSON.parse(readFileSync(configPath, "utf8"));
      expect(effective.extends).toEqual([join(target, ".oxlintrc.json")]);
      expect(effective.plugins).toEqual([]);
      expect(effective.rules["typescript/consistent-type-definitions"]).toEqual(["error", "type"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("does not change normal capabilities when no executable convention config is installed", () => {
    const source = conventionSource();
    const target = typescriptConsumer();
    try {
      expect(
        conventionRegistryCommand("init", [], { root: target, conventionsRoot: source }).status,
      ).toBe("passed");
      const plan = planChecks({ root: target, tier: "lintOnly" });
      expect(plan.checks[0]!.command).toEqual(["bun", "run", "lint"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects repository configuration with an incompatible convention rule option", () => {
    const source = conventionSource();
    const target = typescriptConsumer();
    try {
      write(
        target,
        ".oxlintrc.json",
        `${JSON.stringify(
          { rules: { "typescript/consistent-type-definitions": ["error", "interface"] } },
          null,
          2,
        )}\n`,
      );
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      expect(() => planChecks({ root: target, tier: "lintOnly" })).toThrow(
        "convention-config-conflict",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects nested Oxlint configs rather than silently disabling their behavior", () => {
    const source = conventionSource();
    const target = typescriptConsumer();
    try {
      write(target, "src/.oxlintrc.json", `${JSON.stringify({ rules: {} }, null, 2)}\n`);
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      expect(() => planChecks({ root: target, tier: "lintOnly" })).toThrow(
        "does not yet support nested config trees",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("leaves custom package lint capabilities unchanged when no adapter matches", () => {
    const source = conventionSource();
    const target = typescriptConsumer();
    try {
      write(
        target,
        "package.json",
        `${JSON.stringify(
          {
            name: "consumer",
            scripts: {
              lint: "oxlint .",
              "custom-lint": "eslint .",
              "format:check": "oxfmt --check .",
            },
          },
          null,
          2,
        )}\n`,
      );
      write(
        target,
        ".coding-tooling.json",
        `${JSON.stringify(
          {
            schemaVersion: 1,
            tiers: { lintOnly: ["lint"] },
            capabilityCommands: { consumer: { lint: ["bun", "run", "custom-lint"] } },
          },
          null,
          2,
        )}\n`,
      );
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      const plan = planChecks({ root: target, tier: "lintOnly" });
      expect(plan.checks).toHaveLength(1);
      expect(plan.checks[0]!.command).toEqual(["bun", "run", "custom-lint"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("rejects direct commands that already select a config with equals syntax", () => {
    const source = conventionSource();
    const target = typescriptConsumer();
    try {
      write(
        target,
        ".coding-tooling.json",
        `${JSON.stringify(
          {
            schemaVersion: 1,
            tiers: { lintOnly: ["lint"] },
            capabilityCommands: { consumer: { lint: ["oxlint", "--config=.oxlintrc.json", "."] } },
          },
          null,
          2,
        )}\n`,
      );
      expect(
        conventionRegistryCommand("init", ["typescript"], {
          root: target,
          conventionsRoot: source,
        }).status,
      ).toBe("passed");
      expect(() => planChecks({ root: target, tier: "lintOnly" })).toThrow(
        "already selects a config",
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("uses the same composition seam for Oxfmt format checks", () => {
    const target = typescriptConsumer();
    try {
      write(
        target,
        ".conventions/modules/typescript/technologies/typescript/TS-004.oxfmt.json",
        `${JSON.stringify({ singleQuote: true }, null, 2)}\n`,
      );
      write(
        target,
        ".conventions/configurations.json",
        `${JSON.stringify(
          {
            schemaVersion: 1,
            configurations: [
              {
                module: "typescript",
                rule: "TS-004",
                path: "modules/typescript/technologies/typescript/TS-004.oxfmt.json",
                tool: "oxfmt",
                capability: "format:check",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const [component] = applyConventionConfigurations(target, discoverComponents(target));
      const command = component!.capabilities["format:check"]!;
      expect(command.slice(0, 4)).toEqual(["bun", "run", "format:check", "--config"]);
      const configPath = command[command.indexOf("--config") + 1]!;
      const effective = JSON.parse(readFileSync(configPath, "utf8"));
      expect(effective).toEqual({ semi: true, singleQuote: true });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("merges plugin requirements and stronger severities but rejects incompatible rule options", () => {
    expect(
      composeToolConfiguration({ plugins: ["unicorn"] }, [
        { rule: "RULE-001", value: { plugins: ["typescript"] } },
      ]),
    ).toEqual({ plugins: ["typescript", "unicorn"] });
    expect(
      composeToolConfiguration({ rules: { example: "warn" } }, [
        { rule: "RULE-001", value: { rules: { example: "error" } } },
      ]),
    ).toEqual({ rules: { example: "error" } });
    expect(() =>
      composeToolConfiguration({ rules: { example: ["error", "left"] } }, [
        { rule: "RULE-001", value: { rules: { example: ["error", "right"] } } },
      ]),
    ).toThrow("convention-config-conflict");
  });

  test("compares rule option objects structurally instead of by key insertion order", () => {
    expect(
      composeToolConfiguration(
        {
          rules: {
            example: ["error", { allow: ["a"], deny: ["b"] }],
          },
        },
        [
          {
            rule: "RULE-001",
            value: {
              rules: {
                example: ["error", { deny: ["b"], allow: ["a"] }],
              },
            },
          },
        ],
      ),
    ).toEqual({
      rules: {
        example: ["error", { allow: ["a"], deny: ["b"] }],
      },
    });
  });
});
