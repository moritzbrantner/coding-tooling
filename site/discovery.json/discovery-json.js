import { DEFAULT_DISCOVERY_OWNER, discoveryJson } from "../repository-discovery.js";

const target = document.querySelector("#discovery");
const owner = new URL(location.href).searchParams.get("owner") ?? DEFAULT_DISCOVERY_OWNER;

try {
  const discovery = await discoveryJson(owner);
  target.textContent = `${JSON.stringify(discovery, null, 2)}\n`;
  document.title = `${discovery.owner} · discovery.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "repository-discovery",
      owner,
      summary: { status: "error", suggestedRepository: null },
      error: { message },
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · discovery.json error";
}
