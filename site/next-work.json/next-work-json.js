import {
  apiErrorEnvelope,
  envelopeRequested,
  nextWorkApiEnvelope,
} from "../api-envelope.js";
import { nextWorkJson } from "../next-work.js";

const started = Date.now();
const target = document.querySelector("#next-work");
const parameters = new URL(location.href).searchParams;
const repository = parameters.get("repo");
const useEnvelope = envelopeRequested(parameters);

try {
  if (!repository) throw new Error("Missing repo query parameter.");
  const work = await nextWorkJson(repository);
  const result = useEnvelope ? nextWorkApiEnvelope(work, Date.now() - started) : work;
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${work.repository.fullName} · next-work.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = useEnvelope
    ? apiErrorEnvelope(
        "next-work-discovery",
        "invalid-next-work-url",
        message,
        { repository },
        Date.now() - started,
      )
    : {
        schemaVersion: 1,
        operation: "next-work-discovery",
        repository: repository ? { fullName: repository } : null,
        summary: { status: "error", suggestedWork: null },
        error: { message },
      };
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = "coding-tooling · next-work.json error";
}
