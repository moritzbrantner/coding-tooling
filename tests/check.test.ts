import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCheckPlan } from "../src/check/check.ts";

const fixtures = join(import.meta.dir, "..", "fixtures");

describe("resolveCheckPlan", () => {
  test("only plans capabilities declared by the component", () => {
    const plan = resolveCheckPlan(join(fixtures, "react-vite"), "typecheck");
    expect(plan).toHaveLength(1);
    expect(plan[0]?.command).toEqual(["bun", "run", "typecheck"]);
  });

  test("plans both components in a mixed repository", () => {
    const plan = resolveCheckPlan(join(fixtures, "mixed"), "test:unit");
    expect(plan.map((item) => item.component)).toEqual([
      "root:react-vite",
      "src-tauri:rust",
    ]);
  });
});
