import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

async function runFrom(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(repositoryRoot, "src/entry.ts"), ...args], {
    cwd,
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

async function run(...args: string[]) {
  return runFrom(repositoryRoot, ...args);
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

  test("defer and resume preserve an active finding through the CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-entry-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }, null, 2)}\n`,
      );
      writeFileSync(join(root, "bun.lock"), "");
      writeFileSync(join(root, "tsconfig.json"), "{}\n");
      writeFileSync(join(root, "src", "service.ts"), "export const service = true;\n");

      const findings = await runFrom(root, "findings", "--json");
      expect(findings.exitCode).toBe(0);
      const findingsResult = JSON.parse(findings.stdout) as {
        data?: { findings?: Array<{ id?: string; expectationId?: string }> };
      };
      const finding = findingsResult.data?.findings?.find(
        (item) => item.expectationId === "typescript-source-test",
      );
      expect(finding?.id).toMatch(/^CT-[A-F0-9]{12}$/);

      const deferred = await runFrom(
        root,
        "defer",
        finding!.id!,
        "--reason",
        "covered by the composition boundary for now",
        "--json",
      );
      expect(deferred.exitCode).toBe(0);
      const deferredResult = JSON.parse(deferred.stdout) as {
        operation?: unknown;
        data?: {
          result?: unknown;
          finding?: { disposition?: unknown; deferralEvidence?: unknown };
        };
      };
      expect(deferredResult.operation).toBe("defer");
      expect(deferredResult.data).toMatchObject({
        result: "deferred",
        finding: {
          disposition: "active",
          deferralEvidence: {
            version: 1,
            reason: "covered by the composition boundary for now",
          },
        },
      });

      const resumed = await runFrom(root, "resume", finding!.id!, "--json");
      expect(resumed.exitCode).toBe(0);
      const resumedResult = JSON.parse(resumed.stdout) as {
        operation?: unknown;
        data?: { result?: unknown; finding?: { deferralEvidence?: unknown } };
      };
      expect(resumedResult.operation).toBe("resume");
      expect(resumedResult.data?.result).toBe("active");
      expect(resumedResult.data?.finding?.deferralEvidence).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
