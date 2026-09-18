import { analysisErrorMessage, analysisMessage } from "../analysis-message.js";
import {
  analysisApiEnvelope,
  apiErrorEnvelope,
  envelopeRequested,
} from "../api-envelope.js";
import { analysisQueryJson } from "../analysis-query.js";

const started = Date.now();
const target = document.querySelector("#analysis");
const params = new URL(location.href).searchParams;
const repository = params.get("repo");
const postMessageRequested = params.get("postMessage") === "1";
const useEnvelope = envelopeRequested(params);
const analysisParams = new URLSearchParams(params);
analysisParams.delete("envelope");

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const analysis = await analysisQueryJson(repository, analysisParams);
  const result = useEnvelope
    ? analysisApiEnvelope(analysis, Date.now() - started)
    : analysis;
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${analysis.repository.fullName} · analysis.json`;
  postToParent(analysisMessage(repository, result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = useEnvelope
    ? apiErrorEnvelope(
        "remote-preflight-query",
        "invalid-analysis-url",
        message,
        { repository },
        Date.now() - started,
      )
    : {
        schemaVersion: 1,
        operation: "remote-preflight-query",
        summary: { status: "error" },
        error: { message },
      };
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = "coding-tooling · analysis.json error";
  postToParent(analysisErrorMessage(repository, message));
}

function postToParent(message) {
  if (!postMessageRequested || window.parent === window) return;
  window.parent.postMessage(message, "*");
}
