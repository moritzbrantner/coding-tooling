import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, "src/entry.ts", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("expectation CLI boundary", () => {
  test("findings exits successfully with machine-readable output", async () => {
    const { stdout, stderr, exitCode } = await run("findings", "--json");

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

  test("findings --all and finding expose lifecycle state", async () => {
    const all = await run("findings", "--all", "--json");
    expect(all.exitCode).toBe(0);
    expect(all.stderr).toBe("");
    const allResult = JSON.parse(all.stdout) as { data?: { includeSuppressed?: unknown } };
    expect(allResult.data?.includeSuppressed).toBeTrue();

    const lookup = await run("finding", "CT-FFFFFFFFFFFF", "--json");
    expect(lookup.exitCode).toBe(0);
    expect(lookup.stderr).toBe("");
    const lookupResult = JSON.parse(lookup.stdout) as {
      operation?: unknown;
      data?: { result?: unknown };
    };
    expect(lookupResult.operation).toBe("finding");
    expect(lookupResult.data?.result).toBe("absent");
  });
});
