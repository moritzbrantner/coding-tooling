import { expect, test } from "bun:test";
import { frontendValue } from "../src/index.ts";

test("frontend remains independently reachable", () => {
  expect(frontendValue).toBe(1);
});
