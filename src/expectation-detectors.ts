import {
  missingAggregateCheckFindings,
  missingCliWiringFindings,
  missingRequiredCapabilityFindings,
  missingTypeScriptConfigFindings,
} from "./expectation-package-detectors.ts";
import { createDetectorContext } from "./expectation-package-context.ts";
import { missingRustTestFindings } from "./expectation-rust-test-detector.ts";
import { missingTestFindings } from "./expectation-test-detector.ts";
import type { ExpectationRegistryEntry } from "./expectation-model.ts";
import type { ExpectationDescriptor, RawFinding } from "./expectation-detector-types.ts";

export { createDetectorContext };
export type { ExpectationDescriptor, RawFinding };

export const expectationDescriptors: ExpectationDescriptor[] = [
  {
    id: "package-aggregate-check",
    version: 1,
    description:
      "Packages with multiple verification scripts expose an aggregate check/verify entrypoint",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingAggregateCheckFindings,
  },
  {
    id: "package-cli-wiring",
    version: 1,
    description: "CLI source and package bin wiring resolve consistently",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingCliWiringFindings,
  },
  {
    id: "required-capability-available",
    version: 1,
    description:
      "Explicitly required repository capabilities are provided by a discovered component",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingRequiredCapabilityFindings,
  },
  {
    id: "rust-source-test",
    version: 1,
    description:
      "Production Rust source has conservative inline or integration-test evidence",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingRustTestFindings,
  },
  {
    id: "typescript-project-config",
    version: 1,
    description: "TypeScript packages expose a project configuration",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingTypeScriptConfigFindings,
  },
  {
    id: "typescript-source-test",
    version: 2,
    description:
      "Production TypeScript source is deterministically reachable from a test or matching test artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingTestFindings,
  },
];
expectationDescriptors.sort((left, right) => left.id.localeCompare(right.id));

export function expectationRegistry(): ExpectationRegistryEntry[] {
  return expectationDescriptors.map(({ detect: _detect, ...descriptor }) => ({ ...descriptor }));
}
