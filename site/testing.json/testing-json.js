import {
  apiErrorEnvelope,
  envelopeRequested,
  testingApiEnvelope,
} from "../api-envelope.js";
import { testingJson } from "../testing.js";

const started = Date.now();
const target = document.querySelector("#testing");
const parameters = new URL(location.href).searchParams;
const repository = parameters.get("repo");
const ref = parameters.get("ref");
const useEnvelope = envelopeRequested(parameters);

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const plan = await testingJson(repository, { ref });
  const result = useEnvelope ? testingApiEnvelope(plan, Date.now() - started) : plan;
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${plan.repository.fullName} · testing.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = useEnvelope
    ? apiErrorEnvelope(
        "remote-testing-scaffold-plan",
        "invalid-testing-url",
        message,
        { repository, ref },
        Date.now() - started,
      )
    : { status: "error", error: message };
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
}
