import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("expectation CLI boundary", () => {
  test("findings exits successfully with machine-readable output", async () => {
    const child = Bun.spawn([process.execPath, "src/entry.ts", "findings", "--json"], {
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
      operation?: unknown;
      status?: unknown;
      data?: { findings?: unknown };
    };

    expect(result.operation).toBe("findings");
    expect(result.status).toBe("passed");
    expect(Array.isArray(result.data?.findings)).toBeTrue();
  });
});
