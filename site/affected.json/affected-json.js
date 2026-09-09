import { remoteChangeCommand } from "../change-aware.js";

const target = document.querySelector("#result");
const parameters = new URL(location.href).searchParams;
const repository = parameters.get("repo");
const base = parameters.get("base");
const head = parameters.get("head");
const tier = parameters.get("tier") ?? "fast";
const component = parameters.get("component");
const changedFiles = parameters.getAll("file");

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  if (!base && changedFiles.length === 0)
    throw new Error(
      "Provide ?base=<git-ref> or at least one repeated ?file=<changed-path> parameter.",
    );

  const argv = ["affected", "--tier", tier, "--json"];
  if (base) argv.push("--base", base);
  if (head) argv.push("--head", head);
  if (component) argv.push("--component", component);
  for (const file of changedFiles) argv.push("--changed-file", file);

  const result = await remoteChangeCommand(repository, argv);
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${repository} · affected · affected.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "affected",
      status: "error",
      durationMs: 0,
      data: { repository, base, head, component, changedFiles },
      diagnostics: [{ code: "invalid-affected-url", message }],
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · affected.json error";
}
