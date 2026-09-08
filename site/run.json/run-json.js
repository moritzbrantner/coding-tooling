import { remoteCommand } from "../remote-command.js";

const target = document.querySelector("#result");
const parameters = new URL(location.href).searchParams;
const repository = parameters.get("repo");
const repeatedArgs = parameters.getAll("arg");
const argv = repeatedArgs.length > 0 ? repeatedArgs : parameters.get("argv");

try {
  if (!repository) throw new Error("Missing required ?repo=owner/repository query parameter.");
  if (!argv || (Array.isArray(argv) && argv.length === 0))
    throw new Error(
      "Missing required ?argv=<cli arguments> or repeated ?arg=<argument> parameters.",
    );

  const result = await remoteCommand(repository, argv);
  target.textContent = `${JSON.stringify(result, null, 2)}\n`;
  document.title = `${repository} · ${result.operation} · run.json`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  target.textContent = `${JSON.stringify(
    {
      schemaVersion: 1,
      operation: "remote-command",
      status: "error",
      durationMs: 0,
      data: { repository, requestedArgv: argv ?? null },
      diagnostics: [{ code: "invalid-run-url", message }],
    },
    null,
    2,
  )}\n`;
  document.title = "coding-tooling · run.json error";
}
