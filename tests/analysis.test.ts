import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeRepository } from "../src/analysis.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withTypeScriptProject = true): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-analysis-"));
  roots.push(root);
  if (!withTypeScriptProject) return root;

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: { strict: true, noEmit: true },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("language analysis providers", () => {
  test("reports a TypeScript semantic compiler diagnostic", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "value.ts"), "export const value: string = 123;\n");

    const result = analyzeRepository(root);
    const provider = result.data.providers.find((item) => item.id === "typescript-compiler");
    const diagnostic = result.data.diagnostics.find((item) => item.code === "TS2322");

    expect(result.status).toBe("failed");
    expect(provider).toMatchObject({
      id: "typescript-compiler",
      displayName: "TypeScript native compiler",
      status: "applied",
      capabilities: ["syntax", "semantic", "diagnostics"],
      projects: ["tsconfig.json"],
    });
    expect(provider?.version).toBeTruthy();
    expect(diagnostic).toMatchObject({
      provider: "typescript-compiler",
      code: "TS2322",
      severity: "error",
      project: "tsconfig.json",
      location: {
        path: "src/value.ts",
        startLine: 1,
      },
    });
  });

  test("passes a valid TypeScript project without inventing findings", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "value.ts"), 'export const value: string = "ok";\n');

    const result = analyzeRepository(root);
    const typeScript = result.data.providers.find((item) => item.id === "typescript-compiler");
    const dotnet = result.data.providers.find((item) => item.id === "dotnet-roslyn");

    expect(result.status).toBe("passed");
    expect(typeScript?.status).toBe("applied");
    expect(dotnet?.status).toBe("not-applicable");
    expect(result.data.diagnostics).toEqual([]);
    expect(result.data.actions).toEqual([]);
  });

  test("marks absent language projects not applicable", () => {
    const root = fixture(false);

    const result = analyzeRepository(root);

    expect(result.status).toBe("passed");
    expect(result.data.diagnostics).toEqual([]);
    expect(result.data.actions).toEqual([]);
    expect(result.data.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dotnet-roslyn",
          status: "not-applicable",
          projects: [],
          diagnostics: [],
        }),
        expect.objectContaining({
          id: "typescript-compiler",
          status: "not-applicable",
          projects: [],
          diagnostics: [],
        }),
      ]),
    );
  });
});
