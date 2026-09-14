import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { sourceDependencies } from "../src/source-deps.ts";

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function writePackage(
  root: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
}

function gitRepository(root: string): string {
  expect(spawnSync("git", ["init", "--initial-branch=main", root]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "user.name", "Test"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "add", "."]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "commit", "-m", "source"]).status).toBe(0);
  return run("git", ["rev-parse", "HEAD"], root);
}

function fixture(): {
  consumer: string;
  sourceA: string;
  sourceB: string;
  revisionA: string;
  revisionB: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), "coding-tooling-js-source-deps-"));
  const fallbackA = join(workspace, "fallback-a");
  const fallbackB = join(workspace, "fallback-b");
  const sourceA = join(workspace, "source-a");
  const sourceB = join(workspace, "source-b");
  const consumer = join(workspace, "consumer");

  writePackage(
    fallbackA,
    {
      name: "a-package",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    },
    { "index.js": 'export const value = "registry-a";\n' },
  );
  writePackage(
    fallbackB,
    {
      name: "b-package",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    },
    { "index.js": 'export const value = "registry-b";\n' },
  );

  writePackage(
    sourceA,
    {
      name: "a-package",
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      exports: "./dist/index.js",
      scripts: { build: "bun build.ts" },
    },
    {
      "build.ts":
        'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/index.js", \'export const value = "source-a";\\n\');\n',
    },
  );
  run("bun", ["install"], sourceA);

  writePackage(
    sourceB,
    {
      name: "b-package",
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      exports: "./dist/index.js",
      dependencies: { "a-package": "file:../fallback-a" },
      scripts: { build: "bun build.ts" },
    },
    {
      "build.ts":
        'import { mkdirSync, writeFileSync } from "node:fs"; import { value } from "a-package"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/index.js", `export const value = ${JSON.stringify(`${value}-source-b`)};\\n`);\n',
    },
  );
  run("bun", ["install"], sourceB);

  const revisionA = gitRepository(sourceA);
  const revisionB = gitRepository(sourceB);

  writePackage(consumer, {
    name: "consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      "a-package": "file:../fallback-a",
      "b-package": "file:../fallback-b",
    },
  });
  run("bun", ["install"], consumer);
  writeFileSync(
    join(consumer, ".coding-tooling.source-deps.json"),
    `${JSON.stringify(
      {
        schemaVersion: 4,
        cargo: { repositories: [] },
        javascript: {
          localOnly: true,
          repositories: [
            {
              git: "https://github.com/example/source-a.git",
              rev: revisionA,
              localPath: "../source-a",
              packages: [{ package: "a-package" }],
            },
            {
              git: "https://github.com/example/source-b.git",
              rev: revisionB,
              localPath: "../source-b",
              packages: [{ package: "b-package" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  return { consumer, sourceA, sourceB, revisionA, revisionB };
}

function importedValue(root: string, packageName: string): string {
  return run(
    "bun",
    ["-e", `import(${JSON.stringify(packageName)}).then((module) => console.log(module.value))`],
    root,
  );
}

describe("JavaScript source dependency mode", () => {
  test("builds a coherent source chain and restores the ordinary install", () => {
    const { consumer, sourceA, sourceB, revisionA, revisionB } = fixture();

    const activated = sourceDependencies(consumer, "activate");
    expect(activated.status).toBe("passed");
    expect(activated.data.active).toBe(true);
    expect(activated.data.javascriptPackages).toEqual(["a-package", "b-package"]);
    expect(importedValue(consumer, "a-package")).toBe("source-a");
    expect(importedValue(consumer, "b-package")).toBe("source-a-source-b");

    const state = JSON.parse(
      readFileSync(
        join(consumer, "node_modules", ".coding-tooling-source-deps", "javascript.json"),
        "utf8",
      ),
    );
    expect(state.packages).toEqual([
      {
        package: "a-package",
        git: "https://github.com/example/source-a.git",
        revision: revisionA,
        sourceDir: sourceA,
      },
      {
        package: "b-package",
        git: "https://github.com/example/source-b.git",
        revision: revisionB,
        sourceDir: sourceB,
      },
    ]);

    const smoke = sourceDependencies(consumer, "smoke");
    expect(smoke.status).toBe("passed");

    const deactivated = sourceDependencies(consumer, "deactivate");
    expect(deactivated.status).toBe("passed");
    expect(importedValue(consumer, "a-package")).toBe("registry-a");
    expect(importedValue(consumer, "b-package")).toBe("registry-b");
  });

  test("rejects a local JavaScript checkout at the wrong exact revision", () => {
    const { consumer, sourceA } = fixture();
    writeFileSync(join(sourceA, "README.md"), "changed\n");
    run("git", ["add", "README.md"], sourceA);
    run("git", ["commit", "-m", "changed"], sourceA);

    const activated = sourceDependencies(consumer, "activate");
    expect(activated.status).toBe("error");
    expect(activated.diagnostics[0]?.message).toContain("expected");
  });
});
