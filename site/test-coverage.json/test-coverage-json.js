import { testCoverageJson } from "../test-coverage.js";

const target = document.querySelector("#coverage");
const repository = new URL(location.href).searchParams.get("repo");

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const coverage = await testCoverageJson(repository);
  target.textContent = `${JSON.stringify(coverage, null, 2)}\n`;
  document.title = `${coverage.repository.fullName} · test-coverage.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "test-coverage-observation",
      summary: { status: "error" },
      error: { message },
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · test-coverage.json error";
}
