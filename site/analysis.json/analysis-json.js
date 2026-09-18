import { analysisErrorMessage, analysisMessage } from "../analysis-message.js";
import { analysisQueryJson } from "../analysis-query.js";

const target = document.querySelector("#analysis");
const params = new URL(location.href).searchParams;
const repository = params.get("repo");
const postMessageRequested = params.get("postMessage") === "1";

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const analysis = await analysisQueryJson(repository, params);
  target.textContent = `${JSON.stringify(analysis, null, 2)}\n`;
  document.title = `${analysis.repository.fullName} · analysis.json`;
  postToParent(analysisMessage(repository, analysis));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "remote-preflight-query",
      summary: { status: "error" },
      error: { message },
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · analysis.json error";
  postToParent(analysisErrorMessage(repository, message));
}

function postToParent(message) {
  if (!postMessageRequested || window.parent === window) return;
  window.parent.postMessage(message, "*");
}
