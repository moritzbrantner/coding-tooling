import { expect, test } from "bun:test";
import { value } from "../src/index.ts";

test("entrypoint is reachable", () => {
  expect(value).toBe(2);
});
