import { loadConfig } from "./core.ts";
import {
  missingAggregateCheckFindings,
  missingCliWiringFindings,
  missingRequiredCapabilityFindings,
  missingTypeScriptConfigFindings,
} from "./expectation-package-detectors.ts";
import { createDetectorContext } from "./expectation-package-context.ts";
import { missingTestFindings } from "./expectation-test-detector.ts";
import type { ExpectationRegistryEntry } from "./expectation-model.ts";
import type { ExpectationDescriptor, RawFinding } from "./expectation-detector-types.ts";

export { createDetectorContext };
export type { ExpectationDescriptor, RawFinding };

function applicability(subjects: number) {
  return { status: subjects > 0 ? ("applied" as const) : ("not-applicable" as const), subjects };
}

export const expectationDescriptors: ExpectationDescriptor[] = [
  {
    id: "package-aggregate-check",
    version: 1,
    description:
      "Packages with multiple verification scripts expose an aggregate check/verify entrypoint",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingAggregateCheckFindings,
    coverage: (context) => applicability(context.packages.length),
  },
  {
    id: "package-cli-wiring",
    version: 1,
    description: "CLI source and package bin wiring resolve consistently",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingCliWiringFindings,
    coverage: (context) => applicability(context.packages.length),
  },
  {
    id: "required-capability-available",
    version: 1,
    description:
      "Explicitly required repository capabilities are provided by a discovered component",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingRequiredCapabilityFindings,
    coverage: (context) => applicability((loadConfig(context.root).requiredCapabilities ?? []).length),
  },
  {
    id: "typescript-project-config",
    version: 1,
    description: "TypeScript packages expose a project configuration",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingTypeScriptConfigFindings,
    coverage: (context) =>
      applicability(context.packages.filter((packageInfo) => packageInfo.sourceFiles.length > 0).length),
  },
  {
    id: "typescript-source-test",
    version: 2,
    description:
      "Production TypeScript source is deterministically reachable from a test or matching test artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingTestFindings,
    coverage: (context) =>
      applicability(
        context.packages
          .filter((packageInfo) => {
            const scripts = packageInfo.manifest.scripts ?? {};
            return typeof scripts["test:unit"] === "string" || typeof scripts.test === "string";
          })
          .reduce((total, packageInfo) => total + packageInfo.sourceFiles.length, 0),
      ),
  },
];
expectationDescriptors.sort((left, right) => left.id.localeCompare(right.id));

export function expectationRegistry(): ExpectationRegistryEntry[] {
  return expectationDescriptors.map(({ detect: _detect, coverage: _coverage, ...descriptor }) => ({
    ...descriptor,
  }));
}
