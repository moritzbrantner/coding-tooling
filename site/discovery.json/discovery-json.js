import { apiErrorEnvelope, discoveryApiEnvelope, envelopeRequested } from "../api-envelope.js";
import { DEFAULT_DISCOVERY_OWNER, discoveryJson } from "../repository-discovery.js";

const started = Date.now();
const target = document.querySelector("#discovery");
const parameters = new URL(location.href).searchParams;
const owner = parameters.get("owner") ?? DEFAULT_DISCOVERY_OWNER;
const useEnvelope = envelopeRequested(parameters);

try {
  const discovery = await discoveryJson(owner);
  const result = useEnvelope ? discoveryApiEnvelope(discovery, Date.now() - started) : discovery;
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${discovery.owner} · discovery.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = useEnvelope
    ? apiErrorEnvelope(
        "repository-discovery",
        "invalid-discovery-url",
        message,
        { owner },
        Date.now() - started,
      )
    : {
        schemaVersion: 1,
        operation: "repository-discovery",
        owner,
        summary: { status: "error", suggestedRepository: null },
        error: { message },
      };
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = "coding-tooling · discovery.json error";
}
