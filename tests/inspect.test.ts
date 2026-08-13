import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { inspectRepository } from "../src/inspect/inspect.ts";

const fixtures = join(import.meta.dir, "..", "fixtures");

describe("inspectRepository", () => {
  test("detects Bun TypeScript", () => {
    const result = inspectRepository(join(fixtures, "bun-typescript"));
    expect(result.profiles).toEqual(["bun-typescript"]);
    expect(result.runtimes).toEqual(["bun"]);
    expect(result.capabilities.typecheck).toBe(true);
    expect(result.capabilities.build).toBe(false);
  });

  test("prefers React Vite over generic Bun TypeScript", () => {
    const result = inspectRepository(join(fixtures, "react-vite"));
    expect(result.profiles).toEqual(["react-vite"]);
    expect(result.components[0]?.capabilities).toContain("test:e2e");
  });

  test("detects Rust and .NET", () => {
    expect(inspectRepository(join(fixtures, "rust")).profiles).toEqual(["rust"]);
    expect(inspectRepository(join(fixtures, "dotnet")).profiles).toEqual(["dotnet"]);
  });

  test("detects mixed repositories as multiple components", () => {
    const result = inspectRepository(join(fixtures, "mixed"));
    expect(result.profiles).toEqual(["react-vite", "rust"]);
    expect(result.components.map((component) => component.path)).toEqual([".", "src-tauri"]);
  });
});
