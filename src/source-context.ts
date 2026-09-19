import { resolve } from "node:path";

import { runCommand, type CommandResult } from "./shared.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export const SOURCE_REVISION_ENV = "CODING_TOOLING_SOURCE_SHA" as const;
export const SOURCE_ROOT_ENV = "CODING_TOOLING_SOURCE_ROOT" as const;

export function isSourceRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function pushedContextApplies(root: string): boolean {
  const pushedRoot = process.env[SOURCE_ROOT_ENV]?.trim();
  const contextRoot = pushedRoot ? resolve(pushedRoot) : resolve(process.cwd());
  return resolve(root) === contextRoot;
}

export function sourceRevision(root: string, runner: Runner = runCommand): string | undefined {
  const pushed = process.env[SOURCE_REVISION_ENV]?.trim();
  if (pushed !== undefined && pushed !== "" && pushedContextApplies(root)) {
    return isSourceRevision(pushed) ? pushed.toLowerCase() : undefined;
  }

  const result = runner("git", ["rev-parse", "HEAD"], root);
  const value = result.status === 0 ? result.stdout.trim() : "";
  return isSourceRevision(value) ? value.toLowerCase() : undefined;
}
