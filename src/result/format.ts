import type { AffectedResult, CheckResult, DoctorResult, Inspection } from "../types.ts";

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printInspection(result: Inspection): void {
  console.log(`root: ${result.root}`);
  console.log(`profiles: ${result.profiles.join(", ") || "none"}`);
  console.log(`languages: ${result.languages.join(", ") || "none"}`);
  console.log(`runtimes: ${result.runtimes.join(", ") || "none"}`);
  console.log("components:");
  for (const component of result.components) {
    console.log(`  - ${component.name} (${component.path})`);
    console.log(`    capabilities: ${component.capabilities.join(", ") || "none"}`);
  }
}

export function printChecks(results: CheckResult[]): void {
  if (results.length === 0) {
    console.log("No matching checks are available.");
    return;
  }
  for (const result of results) {
    const mark = result.status === "passed" ? "✓" : "✗";
    console.log(`${mark} ${result.component} ${result.capability} (${result.durationMs}ms)`);
    if (result.status === "failed") {
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    }
  }
}

export function printAffected(result: AffectedResult): void {
  console.log(`changed files: ${result.changedFiles.length}`);
  result.changedFiles.forEach((file) => console.log(`  - ${file}`));
  console.log(`affected components: ${result.affectedComponents.join(", ") || "none"}`);
  console.log(`recommended: ${result.recommendedCapabilities.join(", ") || "none"}`);
}

export function printDoctor(result: DoctorResult): void {
  for (const check of result.checks) {
    const mark = check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "✗";
    console.log(`${mark} ${check.name}: ${check.message}`);
  }
}
