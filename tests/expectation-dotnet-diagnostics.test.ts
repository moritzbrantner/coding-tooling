import { describe, expect, test } from "bun:test";

import type { AnalysisProviderResult } from "../src/analysis-model.ts";
import { dotNetAssignabilityFindings } from "../src/expectation-analysis-detector.ts";
import { semanticFindingId } from "../src/expectation-model.ts";
import type { DetectorContext } from "../src/expectation-package-context.ts";

function provider(lines: number[], code = "CS0029"): AnalysisProviderResult {
  return {
    id: "dotnet-roslyn",
    displayName: "Roslyn via .NET SDK",
    version: "10.0.100",
    status: "applied",
    capabilities: ["semantic", "diagnostics"],
    projects: ["Fixture.csproj"],
    diagnostics: lines.map((line) => ({
      provider: "dotnet-roslyn",
      code,
      severity: "error",
      message: "Cannot implicitly convert type 'int' to 'string'",
      project: "Fixture.csproj",
      location: { path: "src/Value.cs", startLine: line, startColumn: 35 },
    })),
    actions: [],
  };
}

function context(result: AnalysisProviderResult): DetectorContext {
  return {
    root: "/fixture",
    packages: [],
    analysisProvider(id: string) {
      return id === "dotnet-roslyn" ? result : undefined;
    },
  };
}

function findingId(result: AnalysisProviderResult): string | undefined {
  const finding = dotNetAssignabilityFindings(context(result))[0];
  if (!finding) return undefined;
  return semanticFindingId(
    "dotnet-type-assignability",
    1,
    finding.subject.key,
    finding.requirement.key,
  );
}

describe("Roslyn diagnostic-to-finding adapter", () => {
  test("aggregates CS0029 diagnostics by file and preserves provider provenance", () => {
    const findings = dotNetAssignabilityFindings(context(provider([3, 7])));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      subject: { kind: "file", key: "src/Value.cs", path: "src/Value.cs" },
      requirement: { kind: "signal", key: "dotnet-type-assignability" },
      verification: [["coding-tooling", "analyze", "--json"]],
    });
    expect(findings[0]?.analysisEvidence).toHaveLength(2);
    expect(findings[0]?.analysisEvidence?.[0]).toMatchObject({
      provider: "dotnet-roslyn",
      providerVersion: "10.0.100",
      code: "CS0029",
      project: "Fixture.csproj",
      location: { path: "src/Value.cs", startLine: 3 },
    });
  });

  test("keeps the semantic finding identity stable across line movement", () => {
    expect(findingId(provider([1]))).toBe(findingId(provider([40])));
  });

  test("does not promote unrelated Roslyn diagnostics", () => {
    expect(dotNetAssignabilityFindings(context(provider([1], "CS0103")))).toEqual([]);
  });
});
