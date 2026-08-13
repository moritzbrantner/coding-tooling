import { describe, expect, test } from "bun:test";
import { recommendCapabilities } from "../src/affected/affected.ts";

describe("recommendCapabilities", () => {
  test("recommends fast TypeScript checks", () => {
    expect(recommendCapabilities(["src/user/UserForm.tsx"])).toEqual([
      "format",
      "lint",
      "typecheck",
      "test:unit",
    ]);
  });

  test("recommends build for .NET changes", () => {
    expect(recommendCapabilities(["Backend/UserService.cs"])).toEqual([
      "format",
      "build",
      "test:unit",
    ]);
  });
});
