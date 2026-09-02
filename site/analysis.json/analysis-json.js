import { analysisJson } from "../github-analysis.js";

const target = document.querySelector("#analysis");
const repository = new URL(location.href).searchParams.get("repo");

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const analysis = await analysisJson(repository);
  target.textContent = `${JSON.stringify(analysis, null, 2)}\n`;
  document.title = `${analysis.repository.fullName} · analysis.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "remote-preflight",
      summary: { status: "error" },
      error: { message },
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · analysis.json error";
}
