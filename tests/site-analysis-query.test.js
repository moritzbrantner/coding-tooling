import { describe, expect, test } from "bun:test";

import {
  parseAnalysisQuery,
  projectAnalysis,
  queryIsIdentity,
} from "../site/analysis-query.js";

function analysis() {
  return {
    schemaVersion: 1,
    operation: "remote-preflight",
    generatedAt: "2026-09-18T00:00:00.000Z",
    repository: {
      fullName: "example/project",
      defaultBranch: "main",
      revision: "0123456789abcdef0123456789abcdef01234567",
      htmlUrl: "https://github.com/example/project",
    },
    summary: {
      status: "needs-attention",
      componentCount: 2,
      technologyCount: 2,
      findingCount: 4,
      highPriorityFindingCount: 1,
    },
    components: [
      {
        name: "root",
        path: ".",
        kind: "package",
        technologies: ["typescript"],
        capabilities: { lint: ["bun", "run", "lint"], "test:unit": ["bun", "run", "test"] },
      },
      {
        name: "worker",
        path: "packages/worker",
        kind: "rust",
        technologies: ["rust"],
        capabilities: { lint: ["cargo", "clippy"], "test:unit": ["cargo", "test"] },
      },
    ],
    findings: [
      finding("REMOTE-TEST-001", "medium", "Testing gap"),
      finding("REMOTE-CI-002", "high", "CI gap"),
      finding("REMOTE-ENV-005", "medium", "Environment gap"),
      finding("REMOTE-AGENT-001", "low", "Agent policy gap"),
    ],
    limitations: ["Remote evidence is structural."],
    agentHandoff: { localCommands: ["coding-tooling findings --json"] },
  };
}

function finding(id, severity, title) {
  return {
    id,
    severity,
    title,
    evidence: `${title} evidence`,
    recommendation: `Resolve ${title}`,
  };
}

describe("parameterized Pages analysis", () => {
  test("recognizes the unparameterized compatibility path", () => {
    const query = parseAnalysisQuery(new URLSearchParams("repo=example/project"));
    expect(queryIsIdentity(query)).toBe(true);
    expect(queryIsIdentity(parseAnalysisQuery(new URLSearchParams("repo=example/project&view=agent")))).toBe(
      false,
    );
  });

  test("parses a bounded agent query deterministically", () => {
    const parameters = new URLSearchParams(
      "repo=example/project&view=agent&focus=testing&focus=automation&scope=packages/worker&min-severity=medium&limit=5",
    );

    expect(parseAnalysisQuery(parameters)).toEqual({
      view: "agent",
      focus: ["automation", "testing"],
      scope: ["packages/worker"],
      minSeverity: "medium",
      limit: 5,
      finding: null,
      change: {
        base: null,
        head: null,
        changedFiles: [],
        tier: "fast",
      },
    });
  });

  test("fails closed for unsupported query semantics", () => {
    expect(() => parseAnalysisQuery(new URLSearchParams("repo=example/project&view=magic"))).toThrow(
      "view must be full or agent",
    );
    expect(() =>
      parseAnalysisQuery(new URLSearchParams("repo=example/project&focus=semantic-vibes")),
    ).toThrow("focus must use one or more of");
    expect(() =>
      parseAnalysisQuery(new URLSearchParams("repo=example/project&head=feature")),
    ).toThrow("head requires base");
    expect(() =>
      parseAnalysisQuery(new URLSearchParams("repo=example/project&surprise=yes")),
    ).toThrow("Unsupported analysis query parameter");
  });

  test("agent view filters by focus and severity and keeps output compact", () => {
    const query = parseAnalysisQuery(
      new URLSearchParams(
        "repo=example/project&view=agent&focus=automation&min-severity=medium&limit=3",
      ),
    );

    const result = projectAnalysis(analysis(), query);

    expect(result.operation).toBe("remote-preflight-query");
    expect(result.summary).toEqual(
      expect.objectContaining({
        sourceStatus: "needs-attention",
        selectionStatus: "needs-attention",
        selectedFindingCount: 1,
        matchingFindingCount: 1,
      }),
    );
    expect(result.strongestFinding).toEqual(
      expect.objectContaining({ id: "REMOTE-CI-002", severity: "high" }),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "REMOTE-CI-002",
        focus: ["automation"],
      }),
    ]);
    expect(result).not.toHaveProperty("kpis");
  });

  test("scope selects exact components without guessing finding ownership", () => {
    const query = parseAnalysisQuery(
      new URLSearchParams("repo=example/project&view=agent&scope=packages/worker"),
    );
    const result = projectAnalysis(analysis(), query);

    expect(result.components).toEqual([
      {
        name: "worker",
        path: "packages/worker",
        kind: "rust",
        technologies: ["rust"],
        capabilities: ["lint", "test:unit"],
      },
    ]);
    expect(result.findings).toHaveLength(4);
    expect(() =>
      projectAnalysis(
        analysis(),
        parseAnalysisQuery(
          new URLSearchParams("repo=example/project&view=agent&scope=missing-component"),
        ),
      ),
    ).toThrow("Unknown analysis scope");
  });

  test("limits findings after deterministic severity ordering", () => {
    const query = parseAnalysisQuery(
      new URLSearchParams("repo=example/project&view=agent&limit=2"),
    );
    const result = projectAnalysis(analysis(), query);

    expect(result.findings.map((item) => item.id)).toEqual(["REMOTE-CI-002", "REMOTE-ENV-005"]);
    expect(result.summary).toEqual(
      expect.objectContaining({
        matchingFindingCount: 4,
        selectedFindingCount: 2,
        findingsTruncated: true,
      }),
    );
  });

  test("composes existing change-aware evidence without reinterpreting it", () => {
    const query = parseAnalysisQuery(
      new URLSearchParams(
        "repo=example/project&view=agent&base=main&head=feature&changed-file=src/app.ts&tier=fast",
      ),
    );
    const changeContext = {
      schemaVersion: 1,
      operation: "affected",
      status: "passed",
      durationMs: 1,
      data: {
        change: {
          base: "main",
          head: "feature",
          origin: "provided-files",
          files: [{ path: "src/app.ts", status: "provided" }],
        },
        scope: {
          mode: "targeted",
          reasons: ["component-path-ownership"],
          affectedComponents: [
            {
              name: "root",
              path: ".",
              kind: "package",
              changedPaths: ["src/app.ts"],
              governingContracts: [".coding-tooling.json"],
              candidateTests: ["tests/app.test.ts"],
            },
          ],
        },
        validationPlan: {
          tier: "fast",
          complete: true,
          checks: [{ capability: "lint" }, { capability: "test:unit" }],
          missing: [],
        },
      },
      diagnostics: [],
    };

    const result = projectAnalysis(analysis(), query, changeContext);

    expect(result.changeContext).toEqual({
      status: "passed",
      diagnostics: [],
      change: {
        base: "main",
        head: "feature",
        origin: "provided-files",
        files: [{ path: "src/app.ts", status: "provided" }],
      },
      scope: {
        mode: "targeted",
        reasons: ["component-path-ownership"],
        affectedComponents: [
          {
            name: "root",
            path: ".",
            kind: "package",
            changedPaths: ["src/app.ts"],
            governingContracts: [".coding-tooling.json"],
            candidateTests: ["tests/app.test.ts"],
          },
        ],
      },
      validationPlan: {
        tier: "fast",
        complete: true,
        checkCount: 2,
        missing: [],
      },
    });
    expect(result.drillDown.affectedAnalysis).toContain("affected.json/");
    expect(result.drillDown.affectedAnalysis).toContain("file=src%2Fapp.ts");
  });
});
