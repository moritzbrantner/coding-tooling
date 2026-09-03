import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dotNetRoslynAnalysisProvider } from "../src/analysis-dotnet.ts";
import { commandAvailable, runCommand } from "../src/shared.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sdkMajor(): number | undefined {
  if (!commandAvailable("dotnet")) return undefined;
  const result = runCommand("dotnet", ["--version"]);
  if (result.status !== 0) return undefined;
  const major = Number((result.stdout.trim() || result.stderr.trim()).split(".")[0]);
  return Number.isInteger(major) && major > 0 ? major : undefined;
}

function project(source: string): { root: string; projectPath: string } {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-dotnet-analysis-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const major = sdkMajor() ?? 10;
  const projectPath = join(root, "Fixture.csproj");
  writeFileSync(
    projectPath,
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net${major}.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`,
  );
  writeFileSync(join(root, "src", "Value.cs"), source);
  return { root, projectPath };
}

function restore(root: string, projectPath: string): boolean {
  const result = runCommand(
    "dotnet",
    ["restore", projectPath, "--ignore-failed-sources", "--nologo", "--property:NuGetAudit=false"],
    root,
  );
  return result.status === 0;
}

describe("Roslyn-backed .NET analysis", () => {
  test("is not applicable without a C# project", () => {
    const root = mkdtempSync(join(tmpdir(), "coding-tooling-dotnet-empty-"));
    roots.push(root);

    expect(dotNetRoslynAnalysisProvider.analyze(root)).toMatchObject({
      id: "dotnet-roslyn",
      status: "not-applicable",
      projects: [],
      diagnostics: [],
      actions: [],
    });
  });

  test("reports an unrestored project as unavailable when the SDK exists", () => {
    if (!commandAvailable("dotnet")) return;
    const { root } = project("namespace Fixture; public static class Value {}\n");

    const result = dotNetRoslynAnalysisProvider.analyze(root);

    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("restored project");
    expect(result.diagnostics).toEqual([]);
  });

  test("normalizes a real Roslyn compiler diagnostic from a restored project", () => {
    if (!commandAvailable("dotnet")) return;
    const { root, projectPath } = project(
      "namespace Fixture; public static class Value { public static string Get() => 123; }\n",
    );
    expect(restore(root, projectPath)).toBeTrue();

    const result = dotNetRoslynAnalysisProvider.analyze(root);
    const diagnostic = result.diagnostics.find((item) => item.code === "CS0029");

    expect(result.status).toBe("applied");
    expect(result.displayName).toBe("Roslyn via .NET SDK");
    expect(result.version).toBeTruthy();
    expect(result.capabilities).toEqual(["semantic", "diagnostics"]);
    expect(result.projects).toEqual(["Fixture.csproj"]);
    expect(result.actions).toEqual([]);
    expect(diagnostic).toMatchObject({
      provider: "dotnet-roslyn",
      code: "CS0029",
      severity: "error",
      project: "Fixture.csproj",
      location: { path: "src/Value.cs", startLine: 1 },
    });
  });

  test("passes a restored C# project with no compiler diagnostics", () => {
    if (!commandAvailable("dotnet")) return;
    const { root, projectPath } = project(
      'namespace Fixture; public static class Value { public static string Get() => "ok"; }\n',
    );
    expect(restore(root, projectPath)).toBeTrue();

    const result = dotNetRoslynAnalysisProvider.analyze(root);

    expect(result.status).toBe("applied");
    expect(result.diagnostics).toEqual([]);
  });
});
