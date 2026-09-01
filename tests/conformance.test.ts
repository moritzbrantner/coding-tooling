import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

import { conformanceReport } from "../src/conformance.ts";
import { walkFiles } from "../src/shared.ts";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-conformance-"));
  writeJson(join(root, "package.json"), {
    name: "fixture",
    scripts: { lint: "node -e process.exit(0)" },
  });
  return root;
}

function configureTooling(root: string, command = "node"): void {
  writeJson(join(root, ".coding-tooling.json"), {
    schemaVersion: 1,
    tiers: { fast: ["lint"] },
    requiredCapabilities: ["lint"],
    capabilityCommands: {
      ".": {
        lint: [command, "-e", "process.exit(0)"],
      },
    },
  });
}

function installConventions(
  root: string,
  sidecars: Record<string, unknown> = {},
): void {
  writeJson(join(root, "conventions.json"), {
    schemaVersion: 1,
    registry: "coding-agent-conventions",
    modules: ["base"],
  });

  const installRoot = join(root, ".conventions");
  mkdirSync(join(installRoot, "modules", "base"), { recursive: true });
  const contents: Record<string, string> = {
    "index.md": "# Installed conventions\n",
  };
  writeFileSync(join(installRoot, "index.md"), contents["index.md"]);

  for (const [name, value] of Object.entries(sidecars)) {
    const path = `modules/base/${name}`;
    const content = `${JSON.stringify(value, null, 2)}\n`;
    contents[path] = content;
    writeFileSync(join(installRoot, path), content);
  }

  writeJson(join(root, "conventions.lock.json"), {
    schemaVersion: 1,
    sourceRevision: "fixture-revision",
    requestedModules: ["base"],
    resolvedModules: ["base"],
    files: Object.fromEntries(
      Object.entries(contents).map(([path, content]) => [path, hash(content)]),
    ),
  });
}

function snapshot(root: string): Array<[string, string]> {
  return walkFiles(root, 20)
    .sort()
    .map((path) => [relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")]);
}

function findings(result: ReturnType<typeof conformanceReport>) {
  return result.data.findings as Array<{
    code: string;
    status: string;
    severity: string;
    conventionId?: string;
  }>;
}

describe("repository conformance report", () => {
  test("reports missing configuration without throwing", () => {
    const root = repository();

    const result = conformanceReport({ root });

    expect(result.operation).toBe("conformance");
    expect(result.status).toBe("failed");
    expect(findings(result).map((finding) => finding.code)).toContain("tooling-config-missing");
    expect(findings(result).map((finding) => finding.code)).toContain(
      "conventions-manifest-missing",
    );
  });

  test("reports invalid tooling configuration distinctly", () => {
    const root = repository();
    installConventions(root);
    writeJson(join(root, ".coding-tooling.json"), { schemaVersion: 2 });

    const result = conformanceReport({ root });

    expect(result.status).toBe("failed");
    expect(findings(result)).toContainEqual(
      expect.objectContaining({ code: "tooling-config-invalid", status: "failed" }),
    );
  });

  test("reports a configured clean repository as passed", () => {
    const root = repository();
    configureTooling(root);
    installConventions(root);

    const result = conformanceReport({ root });

    expect(result.status).toBe("passed");
    expect(result.data.reportVersion).toBe(1);
    expect(result.data.tools).toEqual([{ name: "node", status: "passed" }]);
    expect(findings(result)).toEqual([]);
    expect(result.data.conventions).toEqual(
      expect.objectContaining({
        manifestPresent: true,
        lockPresent: true,
        selectedModules: ["base"],
      }),
    );
  });

  test("distinguishes unavailable tools from failed checks", () => {
    const root = repository();
    configureTooling(root, "coding-tooling-command-that-does-not-exist");
    installConventions(root);

    const result = conformanceReport({ root });

    expect(result.status).toBe("unavailable");
    expect(findings(result)).toContainEqual(
      expect.objectContaining({ code: "tool-unavailable", status: "unavailable" }),
    );
  });

  test("reports installed convention failures with stable convention IDs", () => {
    const root = repository();
    configureTooling(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "// TODO fix this later\n");
    installConventions(root, {
      "REPO-010.json": {
        schemaVersion: 1,
        ruleId: "REPO-010",
        enforcement: { kind: "builtin", check: "todo-format" },
      },
    });

    const result = conformanceReport({ root });

    expect(result.status).toBe("failed");
    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        code: "convention-enforcement-failed",
        status: "failed",
        conventionId: "REPO-010",
      }),
    );
  });

  test("does not mutate tracked or untracked repository files", () => {
    const root = repository();
    configureTooling(root);
    installConventions(root);
    writeFileSync(join(root, "notes.txt"), "keep me\n");
    const before = snapshot(root);

    conformanceReport({ root });

    expect(snapshot(root)).toEqual(before);
  });
});
