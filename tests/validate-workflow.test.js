import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(import.meta.dir, "../.github/workflows/validate.yml"),
  "utf8",
);

test("validation does not normalize the checkout before authoritative checks", () => {
  const validationStep = workflow.indexOf("- name: Validate through the local Action");
  expect(validationStep).toBeGreaterThan(0);

  const beforeValidation = workflow.slice(0, validationStep);
  expect(beforeValidation).not.toContain("format:write");
  expect(beforeValidation).not.toContain("lint:fix");
  expect(beforeValidation).not.toContain("coding-tooling normalize");
});
