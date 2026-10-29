import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("CLI boundary", () => {
  test("generate list exits successfully with machine-readable output", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "generate", "list", "--json"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const result = JSON.parse(stdout) as {
      status?: unknown;
      data?: unknown;
    };

    expect(result.status).toBe("passed");
    expect(result.data).toBeDefined();
  });

  test("running src/cli.ts directly forwards router-only commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-cli-forward-"));
    try {
      writeFileSync(join(root, "package.json"), '{"name":"forward-fixture"}\n');
      const child = Bun.spawn(
        [
          process.execPath,
          join(repositoryRoot, "src", "cli.ts"),
          "performance",
          "applicability",
          "--root",
          root,
          "--json",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(JSON.parse(stdout)).toMatchObject({ operation: "performance-applicability" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("package bin entrypoints are executable", () => {
    const pkg = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    for (const path of Object.values(pkg.bin)) {
      expect(statSync(join(repositoryRoot, path)).mode & 0o111).not.toBe(0);
    }
  });

  test("convergence rules list is reachable through the installed entrypoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-cli-convergence-rules-"));
    try {
      writeFileSync(join(root, "package.json"), '{"name":"convergence-rules-fixture"}\n');
      const child = Bun.spawn(
        [
          process.execPath,
          join(repositoryRoot, "src", "entry.ts"),
          "convergence",
          "rules",
          "list",
          "--json",
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        operation: "convergence-rules",
        status: "passed",
        data: {
          modes: ["disabled", "suggest", "apply"],
          policy: {
            detectorsRemainActiveWhenMutationIsDisabled: true,
            suggestDoesNotMutate: true,
            applyIsDefault: true,
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalize is reachable through the installed entrypoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-cli-normalize-"));
    try {
      writeFileSync(join(root, "package.json"), '{"name":"normalize-fixture"}\n');
      const child = Bun.spawn(
        [process.execPath, join(repositoryRoot, "src", "entry.ts"), "normalize", "--json"],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        operation: "normalize",
        status: "passed",
        data: {
          result: "no-op",
          idempotent: true,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
