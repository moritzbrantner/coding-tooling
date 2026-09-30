import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { inspectDependencies } from "../src/dependency-inspection.ts";

const roots: string[] = [];
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-dependency-inspection-"));
  roots.push(root);
  return root;
}
function write(root: string, path: string, source: string): void {
  const target = join(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, source);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dependency inspection", () => {
  test("reports only explicit native, WASM and OpenAPI server declarations", () => {
    const root = repository();
    write(
      root,
      "Cargo.toml",
      '[package]\nname="native"\nversion="0.1.0"\nlinks="native-lib"\n[lib]\ncrate-type=["cdylib"]\n',
    );
    write(root, ".cargo/config.toml", '[build]\ntarget="wasm32-unknown-unknown"\n');
    write(
      root,
      "openapi.json",
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "API", version: "1" },
        servers: [{ url: "http://localhost:4321/api" }],
        paths: {},
      }),
    );
    write(root, "unrelated.json", JSON.stringify({ servers: [{ url: "http://example.invalid" }] }));
    const result = inspectDependencies(root);
    expect(result.data.boundaries).toContainEqual(
      expect.objectContaining({
        kind: "http",
        name: "http://localhost:4321/api",
        evidence: ["openapi.json"],
      }),
    );
    expect(result.data.boundaries).toContainEqual(
      expect.objectContaining({ kind: "ffi", name: "native-lib", evidence: ["Cargo.toml"] }),
    );
    expect(result.data.boundaries).toContainEqual(
      expect.objectContaining({
        kind: "wasm",
        name: "wasm32-unknown-unknown",
        evidence: [".cargo/config.toml"],
      }),
    );
    expect(JSON.stringify(result.data.boundaries)).not.toContain("example.invalid");
  });

  test("malformed dependency values and truncated declarations fail explicitly", () => {
    const root = repository();
    write(root, "package.json", '{"name":"bad","dependencies":{"invalid":42}}');
    expect(inspectDependencies(root).status).toBe("error");
    write(root, "package.json", '{"name":');
    expect(inspectDependencies(root).status).toBe("error");
  });

  test("reports direct package classes and sources in stable order without executing scripts", () => {
    const root = repository();
    const manifest = {
      name: "consumer",
      dependencies: { zeta: "1.2.3", local: "workspace:*" },
      devDependencies: { helper: "file:../helper" },
      optionalDependencies: { native: "2.0.0" },
      peerDependencies: { react: "^19.0.0" },
      scripts: { dangerous: "exit 99", lint: "echo ok" },
    };
    write(root, "package.json", JSON.stringify(manifest));
    const before = readFileSync(join(root, "package.json"), "utf8");
    const result = inspectDependencies(root);
    expect(result.status).toBe("passed");
    expect(result.data.components).toEqual([
      expect.objectContaining({
        id: "package:.",
        ecosystem: "javascript",
        dependencies: [
          expect.objectContaining({ name: "helper", kind: "dev", source: "path" }),
          expect.objectContaining({ name: "local", kind: "direct", source: "workspace" }),
          expect.objectContaining({ name: "native", kind: "optional", source: "registry" }),
          expect.objectContaining({ name: "react", kind: "peer", source: "registry" }),
          expect.objectContaining({ name: "zeta", kind: "direct", source: "registry" }),
        ],
      }),
    ]);
    expect(result.data.boundaries).toContainEqual(
      expect.objectContaining({
        kind: "subprocess",
        name: "dangerous",
        command: "exit 99",
        evidence: ["package.json"],
      }),
    );
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    write(
      root,
      "package.json",
      JSON.stringify({ ...manifest, dependencies: { local: "workspace:*", zeta: "1.2.3" } }),
    );
    expect(inspectDependencies(root).data).toEqual(result.data);
  });

  test("reports Cargo member and inherited dependencies with features and target provenance", () => {
    const root = repository();
    write(
      root,
      "Cargo.toml",
      '[workspace]\nmembers=["crates/*"]\n[workspace.dependencies]\nserde={version="1.0.0",features=["derive"]}\n',
    );
    write(
      root,
      "crates/service/Cargo.toml",
      '[package]\nname="service"\nversion="0.1.0"\n[dependencies]\nserde={workspace=true,features=["std"]}\nlocal={path="../local",optional=true}\n[dev-dependencies]\ntestkit={git="https://example.invalid/testkit",rev="abc"}\n[target.\'cfg(unix)\'.build-dependencies]\ncc="1.0.0"\n',
    );
    const result = inspectDependencies(root);
    expect(result.status).toBe("passed");
    expect(result.data.components).toEqual([
      expect.objectContaining({
        ecosystem: "rust",
        dependencies: [
          expect.objectContaining({
            name: "cc",
            kind: "build",
            source: "registry",
            target: "cfg(unix)",
            declaration: "crates/service/Cargo.toml",
          }),
          expect.objectContaining({ name: "local", kind: "optional", source: "path" }),
          expect.objectContaining({
            name: "serde",
            kind: "direct",
            source: "registry",
            features: ["derive", "std"],
            inheritedFrom: "Cargo.toml",
          }),
          expect.objectContaining({ name: "testkit", kind: "dev", source: "git", revision: "abc" }),
        ],
      }),
    ]);
  });

  test("extracts Compose services and dependencies without resolving environment or starting containers", () => {
    const root = repository();
    write(
      root,
      "compose.yaml",
      "services:\n  web:\n    image: web:1\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres:18\n",
    );
    const result = inspectDependencies(root);
    expect(result.status).toBe("passed");
    expect(result.data.boundaries).toEqual([
      expect.objectContaining({
        kind: "docker-service",
        name: "db",
        image: "postgres:18",
        dependsOn: [],
        evidence: ["compose.yaml"],
      }),
      expect.objectContaining({
        kind: "docker-service",
        name: "web",
        dependsOn: ["db"],
        evidence: ["compose.yaml"],
      }),
    ]);
    expect(result.data.coverage).toContainEqual(
      expect.objectContaining({ feature: "compose-services", status: "complete" }),
    );
    write(
      root,
      "compose.yaml",
      "include: [other.yaml]\nservices:\n  web:\n    extends:\n      file: outside.yaml\n      service: base\n",
    );
    expect(inspectDependencies(root).data.coverage).toContainEqual(
      expect.objectContaining({ feature: "compose-services", status: "partial" }),
    );
  });

  test("keeps missing, unsupported, invalid and known-empty evidence distinct", () => {
    const root = repository();
    expect(inspectDependencies(root).status).toBe("unavailable");
    write(root, "package.json", '{"name":"empty"}');
    expect(inspectDependencies(root).data.components).toEqual([
      expect.objectContaining({ status: "complete", dependencies: [] }),
    ]);
    expect(inspectDependencies(root).data.coverage).toContainEqual(
      expect.objectContaining({ feature: "transitive-dependencies", status: "unsupported" }),
    );
    write(root, "service/Service.csproj", '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    expect(inspectDependencies(root).data.components).toContainEqual(
      expect.objectContaining({ ecosystem: "dotnet", status: "unsupported", dependencies: [] }),
    );
    write(root, "compose.yaml", "services: [broken");
    expect(inspectDependencies(root).status).toBe("error");
  });

  test("respects component selection and fixture boundaries", () => {
    const root = repository();
    write(root, "a/package.json", '{"name":"a","dependencies":{"one":"1"}}');
    write(root, "b/package.json", '{"name":"b","dependencies":{"two":"2"}}');
    write(root, "fixtures/c/package.json", '{"name":"c","dependencies":{"three":"3"}}');
    const result = inspectDependencies(root, { component: "b" });
    expect(result.data.components).toEqual([expect.objectContaining({ name: "b" })]);
    expect(inspectDependencies(root, { component: "missing" }).status).toBe("error");
    expect(inspectDependencies(root).data.components).toHaveLength(2);
  });

  test("unresolved Cargo workspace declarations cannot become a complete empty result", () => {
    const root = repository();
    write(
      root,
      "Cargo.toml",
      '[package]\nname="consumer"\nversion="0.1.0"\n[dependencies]\nserde={workspace=true}\n',
    );
    const result = inspectDependencies(root);
    expect(result.data.components).toEqual([
      expect.objectContaining({
        status: "partial",
        dependencies: [expect.objectContaining({ name: "serde", source: "unknown" })],
      }),
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "dependency-workspace-unresolved" }),
    );
    write(
      root,
      "Cargo.toml",
      '[package]\nname="consumer"\nversion="0.1.0"\n[dependencies]\nzeta={workspace=true}\nalpha={workspace=true}\n',
    );
    const shuffled = inspectDependencies(root);
    write(
      root,
      "Cargo.toml",
      '[package]\nname="consumer"\nversion="0.1.0"\n[dependencies]\nalpha={workspace=true}\nzeta={workspace=true}\n',
    );
    expect(inspectDependencies(root).diagnostics).toEqual(shuffled.diagnostics);
    expect(inspectDependencies(root).data).toEqual(shuffled.data);
  });

  test("CLI command is available through the installed entrypoint", () => {
    const root = repository();
    write(root, "package.json", '{"name":"empty"}');
    const child = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "../src/router.ts"),
        "dependencies",
        "inspect",
        "--json",
      ],
      { cwd: root },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      schemaVersion: 1,
      operation: "dependencies",
      status: "passed",
      data: { reportVersion: 1 },
    });
  });
});
