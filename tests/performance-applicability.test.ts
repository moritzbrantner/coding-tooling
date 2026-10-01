import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeExpectations } from "../src/expectations.ts";
import {
  performanceApplicability,
  fleetPerformanceApplicability,
} from "../src/performance-applicability.ts";

const roots: string[] = [];
function fixture(manifest: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "performance-applicability-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, ...manifest }),
  );
  return root;
}
function declare(root: string, component: Record<string, unknown>) {
  mkdirSync(join(root, ".performance"), { recursive: true });
  writeFileSync(
    join(root, ".performance/applicability.json"),
    JSON.stringify({ schemaVersion: 1, components: [{ component: ".", ...component }] }),
  );
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function row(report: ReturnType<typeof performanceApplicability>, family: string) {
  return report.data.components[0]?.families.find((value) => value.family === family);
}
describe("performance applicability", () => {
  test("publishable exports with omitted private retain size applicability", () => {
    const root = fixture({ private: undefined, exports: { ".": "./index.ts" } });
    expect(row(performanceApplicability(root), "size-budget")?.state).toBe("applicable-missing");
    const internal = fixture({ private: true, exports: { ".": "./index.ts" } });
    expect(row(performanceApplicability(internal), "size-budget")?.state).toBe("not-applicable");
  });
  test("derived output debt is excluded while genuine production source debt remains visible", () => {
    const root = fixture();
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/operation.ts"),
      '// TODO: implement the declared operation\nexport function operation() { throw new Error("Not implemented"); }\n',
    );
    for (const derived of [".cache", ".artifacts", ".asset-tooling"]) {
      mkdirSync(join(root, derived));
      writeFileSync(
        join(root, derived, "bundled.js"),
        '// TODO: bundled third-party marker\nthrow new Error("Not implemented");\n',
      );
    }
    const findings = analyzeExpectations(root).findings;
    expect(findings.some((value) => value.subject.path === "src/operation.ts")).toBe(true);
    expect(
      findings.some(
        (value) =>
          value.subject.path?.startsWith(".artifacts/") ||
          value.subject.path?.startsWith(".cache/") ||
          value.subject.path?.startsWith(".asset-tooling/"),
      ),
    ).toBe(false);
  });
  test("availability rejects executable-directory symlinks and accepts local executable files without running them", () => {
    if (process.platform === "win32") return;
    const root = fixture();
    writeFileSync(join(root, "bench.ts"), "export {};\n");
    mkdirSync(join(root, "directory"));
    symlinkSync(join(root, "directory"), join(root, "collector"));
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        capabilityCommands: { ".": { benchmark: [join(root, "collector"), "bench.ts"] } },
      }),
    );
    declare(root, {
      scenarios: [
        {
          family: "react-render-budget",
          capability: "benchmark",
          path: "bench.ts",
          tools: [],
          platforms: [],
        },
      ],
    });
    expect(row(performanceApplicability(root), "react-render-budget")?.state).toBe(
      "unsupported-environment",
    );
    rmSync(join(root, "collector"));
    writeFileSync(join(root, "collector"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(root, "collector"), 0o755);
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        capabilityCommands: { ".": { benchmark: ["./collector", "bench.ts"] } },
      }),
    );
    expect(row(performanceApplicability(root), "react-render-budget")?.state).toBe("supported");
  });
  test("maintained Axum and ASP.NET Web shapes expose service runtime/load applicability", () => {
    const rust = fixture();
    writeFileSync(
      join(rust, "Cargo.toml"),
      `[package]\nname = "api"\nversion = "0.1.0"\n[dependencies]\naxum = "0.8.8"\n`,
    );
    const api = performanceApplicability(rust).data.components.find((value) =>
      value.roles.includes("service"),
    );
    expect(api?.families.find((value) => value.family === "load-smoke")?.state).toBe(
      "applicable-missing",
    );
    const dotnet = fixture();
    writeFileSync(
      join(dotnet, "Api.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    );
    const web = performanceApplicability(dotnet).data.components.find((value) =>
      value.roles.includes("dotnet-service"),
    );
    for (const family of ["benchmark-smoke", "runtime", "memory", "load-smoke"])
      expect(web?.families.find((value) => value.family === family)?.state).toBe(
        "applicable-missing",
      );
  });
  test("scenario traversal, symlinks, duplicate families and stale selectors remain unavailable", () => {
    const root = fixture({
      dependencies: { react: "19.2.6" },
      scripts: { benchmark: "bun bench.ts" },
    });
    writeFileSync(join(root, "bench.ts"), "export {};\n");
    for (const scenarioPath of ["../bench.ts", "/bench.ts", "a/../bench.ts"]) {
      declare(root, {
        scenarios: [
          {
            family: "react-render-budget",
            capability: "benchmark",
            path: scenarioPath,
            tools: [],
            platforms: [],
          },
        ],
      });
      expect(performanceApplicability(root).status).toBe("unavailable");
    }
    if (process.platform !== "win32") {
      symlinkSync(join(root, "bench.ts"), join(root, "alias.ts"));
      declare(root, {
        scenarios: [
          {
            family: "react-render-budget",
            capability: "benchmark",
            path: "alias.ts",
            tools: [],
            platforms: [],
          },
        ],
      });
      expect(performanceApplicability(root).status).toBe("unavailable");
    }
    const scenario = {
      family: "react-render-budget",
      capability: "benchmark",
      path: "bench.ts",
      tools: [],
      platforms: [],
    };
    declare(root, { scenarios: [scenario, scenario] });
    expect(performanceApplicability(root).status).toBe("unavailable");
    declare(root, { component: "missing-package", scenarios: [scenario] });
    expect(performanceApplicability(root).status).toBe("unavailable");
  });
  test("source role ordering is deterministic and explicit .NET service roles expose runtime and load debt", () => {
    const root = fixture();
    declare(root, { roles: ["dotnet-service", "distributable"] });
    const first = performanceApplicability(root);
    declare(root, { roles: ["distributable", "dotnet-service"] });
    expect(performanceApplicability(root).data.components).toEqual(first.data.components);
    for (const family of ["benchmark-smoke", "runtime", "memory", "load-smoke", "size-budget"])
      expect(row(first, family)?.state).toBe("applicable-missing");
  });
  test("generated consumer manifests do not create production audit components", () => {
    const root = fixture();
    for (const derived of [".cache", ".artifacts", ".asset-tooling"]) {
      const directory = join(root, derived, "consumer");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name: "generated", dependencies: { react: "19.2.6" } }),
      );
    }
    expect(performanceApplicability(root).data.components.map((value) => value.name)).toEqual([
      "fixture",
    ]);
    expect(
      performanceApplicability(join(root, ".cache", "consumer")).data.components.map(
        (value) => value.name,
      ),
    ).toEqual(["generated"]);
  });
  test("ordinary build capability cannot masquerade as measured runtime evidence", () => {
    const root = fixture({ dependencies: { react: "19.2.6" }, scripts: { build: "bun bench.ts" } });
    writeFileSync(join(root, "bench.ts"), "export {};\n");
    declare(root, {
      scenarios: [
        { family: "runtime", capability: "build", path: "bench.ts", tools: [], platforms: [] },
      ],
    });
    expect(performanceApplicability(root).status).toBe("unavailable");
  });
  test("explicit capability override is honored without running its command", () => {
    const root = fixture({ dependencies: { react: "19.2.6" } });
    writeFileSync(join(root, "bench.ts"), "export {};\n");
    writeFileSync(
      join(root, ".coding-tooling.json"),
      JSON.stringify({
        schemaVersion: 1,
        capabilityCommands: { ".": { benchmark: ["unavailable-collector", "bench.ts"] } },
      }),
    );
    declare(root, {
      scenarios: [
        {
          family: "react-render-budget",
          capability: "benchmark",
          path: "bench.ts",
          tools: [],
          platforms: [],
        },
      ],
    });
    expect(
      row(performanceApplicability(root, { available: () => false }), "react-render-budget")?.state,
    ).toBe("unsupported-environment");
  });
  test("React shape exposes missing browser/render scenarios without inventing benchmarks", () => {
    const root = fixture({
      dependencies: { react: "19.2.6" },
      scripts: { benchmark: "bun bench.ts" },
    });
    const report = performanceApplicability(root);
    expect(row(report, "browser-audit")?.state).toBe("applicable-missing");
    expect(row(report, "react-render-budget")?.state).toBe("applicable-missing");
    expect(row(report, "load-smoke")?.state).toBe("not-applicable");
    expect(report.data.execution).toBe("not-requested");
  });
  test("scenario plus capability plus supported prerequisites establishes structural support", () => {
    const root = fixture({
      dependencies: { react: "19.2.6" },
      scripts: { benchmark: "bun bench.ts" },
    });
    writeFileSync(join(root, "bench.ts"), 'throw new Error("audit must not execute");');
    declare(root, {
      scenarios: [
        {
          family: "react-render-budget",
          capability: "benchmark",
          path: "bench.ts",
          tools: ["declared-collector"],
          platforms: [process.platform],
        },
      ],
    });
    const before = readFileSync(join(root, "bench.ts"));
    const report = performanceApplicability(root, { available: () => true });
    expect(row(report, "react-render-budget")?.state).toBe("supported");
    expect(row(report, "react-render-budget")?.scenario?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(root, "bench.ts"))).toEqual(before);
  });
  test("installed collector alone stays missing and a declared missing collector is unsupported", () => {
    const root = fixture({
      dependencies: { react: "19.2.6" },
      scripts: { benchmark: "bun bench.ts" },
    });
    expect(
      row(performanceApplicability(root, { available: () => true }), "react-render-budget")?.state,
    ).toBe("applicable-missing");
    writeFileSync(join(root, "bench.ts"), "export {};\n");
    declare(root, {
      scenarios: [
        {
          family: "react-render-budget",
          capability: "benchmark",
          path: "bench.ts",
          tools: ["missing"],
          platforms: [process.platform],
        },
      ],
    });
    expect(
      row(
        performanceApplicability(root, { available: (tool) => tool !== "missing" }),
        "react-render-budget",
      )?.state,
    ).toBe("unsupported-environment");
  });
  test("platform mismatch is unsupported; absent file or capability remains missing", () => {
    const root = fixture({
      dependencies: { react: "19.2.6" },
      scripts: { benchmark: "bun bench.ts" },
    });
    writeFileSync(join(root, "bench.ts"), "export {};\n");
    declare(root, {
      scenarios: [
        {
          family: "react-render-budget",
          capability: "benchmark",
          path: "bench.ts",
          tools: [],
          platforms: ["unsupported-platform"],
        },
      ],
    });
    expect(row(performanceApplicability(root), "react-render-budget")?.state).toBe(
      "unsupported-environment",
    );
    declare(root, {
      scenarios: [
        {
          family: "react-render-budget",
          capability: "benchmark",
          path: "missing.ts",
          tools: [],
          platforms: [],
        },
      ],
    });
    expect(row(performanceApplicability(root), "react-render-budget")?.state).toBe(
      "applicable-missing",
    );
    expect(performanceApplicability(root).status).toBe("unavailable");
  });
  test("repository-owned non-applicability requires a reason and cannot conceal a wired scenario", () => {
    const root = fixture({ dependencies: { react: "19.2.6" } });
    declare(root, {
      notApplicable: [
        {
          family: "react-render-budget",
          reason: "Static documentation shell has no stateful interactions.",
        },
      ],
    });
    expect(row(performanceApplicability(root), "react-render-budget")?.state).toBe(
      "not-applicable",
    );
    declare(root, { notApplicable: [{ family: "react-render-budget", reason: "" }] });
    expect(performanceApplicability(root).status).toBe("unavailable");
  });
  test("Expo startup/frame/memory and explicit kernel role use distinct applicability families", () => {
    const mobile = fixture({ dependencies: { expo: "55.0.0", react: "19.2.6" } });
    const report = performanceApplicability(mobile);
    for (const family of ["startup", "frame-stall", "memory"])
      expect(row(report, family)?.state).toBe("applicable-missing");
    expect(row(report, "browser-audit")?.state).toBe("not-applicable");
    const native = fixture();
    writeFileSync(
      join(native, "Cargo.toml"),
      `[package]
name = "kernel"
version = "0.1.0"
`,
    );
    declare(native, { roles: ["rust-kernel"] });
    for (const family of ["benchmark-smoke", "hotspots", "memory", "size-budget"])
      expect(row(performanceApplicability(native), family)?.state).toBe("applicable-missing");
  });
  test("fleet includes maintained repositories, excludes archived, and preserves per-repository failures", () => {
    const fleet = mkdtempSync(join(tmpdir(), "performance-fleet-"));
    roots.push(fleet);
    for (const [name, status] of [
      ["active", "active"],
      ["archived", "archived"],
    ]) {
      const root = join(fleet, name!);
      mkdirSync(root);
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".repository.toml"),
        `schema_version = 1
id = "owner/${name}"
kind = "library"
status = "${status}"
`,
      );
      writeFileSync(join(root, "package.json"), JSON.stringify({ name, private: true }));
    }
    const report = fleetPerformanceApplicability(fleet);
    expect(report.data.repositories.map((value) => value.id)).toEqual(["owner/active"]);
    expect(report.data.excluded).toEqual(["owner/archived"]);
  });
});
