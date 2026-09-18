import { apiErrorEnvelope, coverageApiEnvelope, envelopeRequested } from "../api-envelope.js";
import { testCoverageJson } from "../test-coverage.js";

const started = Date.now();
const target = document.querySelector("#coverage");
const parameters = new URL(location.href).searchParams;
const repository = parameters.get("repo");
const ref = parameters.get("ref");
const useEnvelope = envelopeRequested(parameters);

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const coverage = await testCoverageJson(repository, { ref });
  const result = useEnvelope ? coverageApiEnvelope(coverage, Date.now() - started) : coverage;
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${coverage.repository.fullName} · test-coverage.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = useEnvelope
    ? apiErrorEnvelope(
        "test-coverage-observation",
        "invalid-test-coverage-url",
        message,
        { repository, ref },
        Date.now() - started,
      )
    : {
        schemaVersion: 1,
        operation: "test-coverage-observation",
        summary: { status: "error" },
        error: { message },
      };
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = "coding-tooling · test-coverage.json error";
}
