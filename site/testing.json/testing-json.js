import { testingJson } from "../testing.js";

const target = document.querySelector("#testing");
const repository = new URL(location.href).searchParams.get("repo");

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  const plan = await testingJson(repository);
  target.textContent = `${JSON.stringify(plan, null, 2)}\n`;
  document.title = `${plan.repository.fullName} · testing.json`;
} catch (error) {
  target.textContent = `${JSON.stringify(
    { status: "error", error: error instanceof Error ? error.message : String(error) },
    null,
    2,
  )}\n`;
}
