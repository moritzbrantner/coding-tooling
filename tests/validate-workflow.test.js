import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(import.meta.dir, "../.github/workflows/validate.yml"),
  "utf8",
);

test("validation observes the committed checkout without normalization", () => {
  expect(workflow).toContain("- name: Validate through the local Action");
  expect(workflow).not.toContain("format:write");
  expect(workflow).not.toContain("lint:fix");
  expect(workflow).not.toContain("coding-tooling normalize");
});
