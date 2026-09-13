import { expect, test } from "bun:test";

import { routerMain } from "../src/router.ts";

test("rejects incomplete agent commands without inventing missing task data", () => {
  expect(routerMain(["agent"])).toBe(2);
});
