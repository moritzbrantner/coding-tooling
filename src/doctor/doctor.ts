import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { inspectRepository } from "../inspect/inspect.ts";
import { runCommand } from "../shared/command.ts";
import type { DoctorCheck, DoctorResult } from "../types.ts";

function checkExecutable(name: string): DoctorCheck {
  const found = Bun.which(name);
  return found
    ? { name: `runtime:${name}`, status: "passed", message: found }
    : { name: `runtime:${name}`, status: "failed", message: `${name} is not available on PATH` };
}

function checkWritable(path: string, name: string): DoctorCheck {
  try {
    accessSync(path, constants.W_OK);
    return { name, status: "passed", message: `${path} is writable` };
  } catch {
    return { name, status: "failed", message: `${path} is not writable` };
  }
}

function checkGitIndex(root: string): DoctorCheck {
  const gitDirResult = runCommand(["git", "rev-parse", "--git-dir"], root);
  if (gitDirResult.exitCode !== 0 || !gitDirResult.stdout) {
    return { name: "git:index", status: "failed", message: "Unable to resolve Git directory" };
  }

  const gitDir = isAbsolute(gitDirResult.stdout)
    ? gitDirResult.stdout
    : resolve(root, gitDirResult.stdout);
  const index = join(gitDir, "index");
  return checkWritable(existsSync(index) ? index : gitDir, "git:index");
}

function checkBunLock(componentRoot: string): DoctorCheck {
  const hasLock = existsSync(join(componentRoot, "bun.lock")) || existsSync(join(componentRoot, "bun.lockb"));
  return hasLock
    ? { name: "bun:lockfile", status: "passed", message: `Bun lockfile found in ${componentRoot}` }
    : {
        name: "bun:lockfile",
        status: "warning",
        message: `No bun.lock or bun.lockb found in ${componentRoot}`,
      };
}

export function doctorRepository(start = process.cwd()): DoctorResult {
  const inspection = inspectRepository(start);
  const checks: DoctorCheck[] = [];

  checks.push(checkExecutable("git"));
  checks.push(checkWritable(inspection.root, "repository:writable"));
  checks.push(checkGitIndex(inspection.root));

  for (const runtime of inspection.runtimes) checks.push(checkExecutable(runtime));

  const bunComponents = inspection.components.filter((component) => component.runtime === "bun");
  for (const component of bunComponents) {
    const componentRoot = component.path === "." ? inspection.root : join(inspection.root, component.path);
    checks.push(checkBunLock(componentRoot));
  }

  const deduplicated = [...new Map(checks.map((check) => [`${check.name}:${check.message}`, check])).values()];
  return {
    schemaVersion: 1,
    root: inspection.root,
    status: deduplicated.some((check) => check.status === "failed") ? "failed" : "passed",
    checks: deduplicated,
  };
}
