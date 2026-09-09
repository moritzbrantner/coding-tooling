import { nextWorkJson } from "../next-work.js";

const target = document.querySelector("#next-work");
const repository = new URL(location.href).searchParams.get("repo");

try {
  if (!repository) throw new Error("Missing repo query parameter.");
  const result = await nextWorkJson(repository);
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${result.repository.fullName} · next-work.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "next-work-discovery",
      repository: repository ? { fullName: repository } : null,
      summary: { status: "error", suggestedWork: null },
      error: { message },
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · next-work.json error";
}
