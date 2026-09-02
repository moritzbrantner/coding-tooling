import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ReconcileFileResult = "created" | "changed" | "unchanged";

export function reconcileTextFile(path: string, desiredContent: string): ReconcileFileResult {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === desiredContent) return "unchanged";
    writeFileSync(path, desiredContent, "utf8");
    return "changed";
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desiredContent, "utf8");
  return "created";
}

export function reconciliationChanged(result: ReconcileFileResult): boolean {
  return result !== "unchanged";
}
