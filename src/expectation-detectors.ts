import {
  missingBenchmarkEvidenceFindings,
  missingTestCapabilityFindings,
  sourceDebtMarkerFindings,
  sourceUnimplementedStubFindings,
} from "./expectation-gap-detectors.ts";
import {
  missingAggregateCheckFindings,
  missingCliWiringFindings,
  missingRequiredCapabilityFindings,
  missingTypeScriptConfigFindings,
} from "./expectation-package-detectors.ts";
import { createDetectorContext } from "./expectation-package-context.ts";
import { missingCargoTargetPathFindings } from "./expectation-rust-detector.ts";
import { missingJavaScriptTestFindings, missingTestFindings } from "./expectation-test-detector.ts";
import type { ExpectationRegistryEntry } from "./expectation-model.ts";
import type { ExpectationDescriptor, RawFinding } from "./expectation-detector-types.ts";

export { createDetectorContext };
export type { ExpectationDescriptor, RawFinding };

export const expectationDescriptors: ExpectationDescriptor[] = [
  {
    id: "benchmark-evidence",
    version: 1,
    description: "Declared benchmark capabilities have a conventional benchmark artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingBenchmarkEvidenceFindings,
  },
  {
    id: "javascript-source-test",
    version: 1,
    description:
      "Production JavaScript source is deterministically reachable from a test or matching test artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingJavaScriptTestFindings,
  },
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
    id: "package-test-capability",
    version: 1,
    description:
      "JavaScript/TypeScript packages with production source expose a deterministic test capability",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingTestCapabilityFindings,
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
    id: "rust-cargo-target-path",
    version: 1,
    description: "Explicit Cargo lib/bin/test/example/bench target paths exist",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: missingCargoTargetPathFindings,
  },
  {
    id: "source-debt-marker",
    version: 1,
    description: "Production source TODO/FIXME markers are visible as explicit repository debt",
    defaultSeverity: "info",
    policyKind: "advisory",
    detect: sourceDebtMarkerFindings,
  },
  {
    id: "source-unimplemented-stub",
    version: 1,
    description: "Production source does not retain explicit unimplemented runtime stubs",
    defaultSeverity: "warning",
    policyKind: "advisory",
    detect: sourceUnimplementedStubFindings,
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
