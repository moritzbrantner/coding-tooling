import { runCommand, type CommandResult } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export const SOURCE_REVISION_ENV = "CODING_TOOLING_SOURCE_SHA" as const;

export function isSourceRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

export function sourceRevision(root: string, runner: Runner = runCommand): string | undefined {
  const pushed = process.env[SOURCE_REVISION_ENV]?.trim();
  if (pushed !== undefined && pushed !== "") {
    return isSourceRevision(pushed) ? pushed.toLowerCase() : undefined;
  }

  const result = runner("git", ["rev-parse", "HEAD"], root);
  const value = result.status === 0 ? result.stdout.trim() : "";
  return isSourceRevision(value) ? value.toLowerCase() : undefined;
}
