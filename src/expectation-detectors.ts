import {
  dotNetAssignabilityFindings,
  typeScriptAssignabilityFindings,
} from "./expectation-analysis-detector.ts";
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
import { missingRustTestFindings } from "./expectation-rust-test-detector.ts";
import { missingJavaScriptTestFindings, missingTestFindings } from "./expectation-test-detector.ts";
import type {
  ExpectationDescriptor,
  ExpectationRegistryRecord,
} from "./expectation-detector-types.ts";

export { createDetectorContext };
export type {
  EvidenceBasis,
  ExpectationDescriptor,
  ExpectationEvidenceContract,
  ExpectationRegistryRecord,
  RawFinding,
} from "./expectation-detector-types.ts";

export const expectationDescriptors: ExpectationDescriptor[] = [
  {
    id: "benchmark-evidence",
    version: 1,
    description: "Declared benchmark capabilities have a conventional benchmark artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "repository-filesystem-and-capability-discovery",
      independenceKey: "repository-benchmark-structure",
      proves: "A declared benchmark capability has a conventional benchmark artifact that coding-tooling can discover.",
      limitations: [
        "Does not prove that the benchmark executes successfully.",
        "Does not prove that the benchmark is representative or measures the intended performance property.",
      ],
    },
    detect: missingBenchmarkEvidenceFindings,
  },
  {
    id: "dotnet-type-assignability",
    version: 1,
    description: "Roslyn implicit-conversion diagnostics are exposed as deterministic evidence",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "semantic",
      oracle: "dotnet-roslyn",
      independenceKey: "dotnet-roslyn",
      proves: "The pinned .NET build/Roslyn pipeline emitted CS0029 implicit-conversion diagnostics for the analyzed project state.",
      limitations: [
        "Does not independently confirm diagnostics already emitted by the same Roslyn invocation.",
        "Does not prove runtime correctness or that a particular repair is semantically correct.",
      ],
    },
    detect: dotNetAssignabilityFindings,
  },
  {
    id: "javascript-source-test",
    version: 1,
    description:
      "Production JavaScript source is deterministically reachable from a test or matching test artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "javascript-static-test-reachability",
      independenceKey: "static-test-reachability",
      proves: "A production JavaScript source file has mechanically discoverable matching-test or static test-reachability evidence.",
      limitations: [
        "Does not prove that the test asserts useful behavior.",
        "Does not resolve dynamic imports, unresolved aliases, or other relationships the conservative graph deliberately leaves unknown.",
      ],
    },
    detect: missingJavaScriptTestFindings,
  },
  {
    id: "package-aggregate-check",
    version: 1,
    description:
      "Packages with multiple verification scripts expose an aggregate check/verify entrypoint",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "configuration",
      oracle: "package-manifest",
      independenceKey: "package-manifest",
      proves: "A package with multiple discovered verification scripts exposes an aggregate check or verify entrypoint.",
      limitations: [
        "Does not prove that the aggregate command invokes every intended verification step.",
        "Does not prove that any verification command succeeds.",
      ],
    },
    detect: missingAggregateCheckFindings,
  },
  {
    id: "package-cli-wiring",
    version: 1,
    description: "CLI source and package bin wiring resolve consistently",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "package-manifest-and-filesystem",
      independenceKey: "package-structure",
      proves: "Declared package CLI wiring resolves to mechanically discoverable source paths and missing wiring is surfaced.",
      limitations: [
        "Does not prove that the CLI starts successfully.",
        "Does not prove command behavior, argument semantics, or packaging correctness beyond the inspected wiring.",
      ],
    },
    detect: missingCliWiringFindings,
  },
  {
    id: "package-test-capability",
    version: 1,
    description:
      "JavaScript/TypeScript packages with production source expose a deterministic test capability",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "configuration",
      oracle: "package-manifest-and-source-discovery",
      independenceKey: "package-test-configuration",
      proves: "A package with discovered production script source exposes a recognized test capability.",
      limitations: [
        "Does not prove that the configured test command runs or passes.",
        "Does not prove behavioral coverage of the package source.",
      ],
    },
    detect: missingTestCapabilityFindings,
  },
  {
    id: "required-capability-available",
    version: 1,
    description:
      "Explicitly required repository capabilities are provided by a discovered component",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "configuration",
      oracle: "coding-tooling-config-and-component-discovery",
      independenceKey: "capability-discovery",
      proves: "Every explicitly required coding-tooling capability is provided by at least one discovered component command.",
      limitations: [
        "Does not execute the discovered capability command.",
        "Does not prove that the command is authoritative for the semantic capability it advertises.",
      ],
    },
    detect: missingRequiredCapabilityFindings,
  },
  {
    id: "rust-cargo-target-path",
    version: 1,
    description: "Explicit Cargo lib/bin/test/example/bench target paths exist",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "cargo-manifest-and-filesystem",
      independenceKey: "cargo-target-structure",
      proves: "Explicit Cargo target path declarations resolve to files in the inspected repository tree.",
      limitations: [
        "Does not prove that the target compiles.",
        "Does not infer implicit Cargo targets that are outside the explicit-path contract.",
      ],
    },
    detect: missingCargoTargetPathFindings,
  },
  {
    id: "rust-source-test",
    version: 1,
    description:
      "Reachable Rust source has mechanically provable inline or integration-test reachability",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "rust-module-and-test-reachability",
      independenceKey: "static-test-reachability",
      proves: "Mechanically reachable Rust source has recognized inline or integration-test reachability through the conservative module graph.",
      limitations: [
        "Does not prove behavioral assertions or runtime coverage.",
        "Conditional modules and ambiguous semantic relationships remain unknown rather than being inferred.",
      ],
    },
    detect: missingRustTestFindings,
  },
  {
    id: "source-debt-marker",
    version: 1,
    description: "Production source TODO/FIXME markers are visible as explicit repository debt",
    defaultSeverity: "info",
    policyKind: "advisory",
    evidenceContract: {
      basis: "syntax",
      oracle: "bounded-source-text-scan",
      independenceKey: "source-text-scan",
      proves: "Recognized TODO/FIXME markers are present in inspected production source text.",
      limitations: [
        "Does not prove that a marker represents actionable or current debt.",
        "Does not understand comments or strings beyond the detector's bounded lexical contract.",
      ],
    },
    detect: sourceDebtMarkerFindings,
  },
  {
    id: "source-unimplemented-stub",
    version: 1,
    description: "Production source does not retain explicit unimplemented runtime stubs",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "syntax",
      oracle: "bounded-source-text-scan",
      independenceKey: "source-text-scan",
      proves: "Recognized explicit unimplemented runtime-stub patterns are present in inspected production source text.",
      limitations: [
        "Does not prove that all incomplete business logic is detected.",
        "Does not provide independent confirmation from other checks sharing the same source-text-scan oracle.",
      ],
    },
    detect: sourceUnimplementedStubFindings,
  },
  {
    id: "typescript-project-config",
    version: 1,
    description: "TypeScript packages expose a project configuration",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "typescript-source-and-filesystem",
      independenceKey: "typescript-project-structure",
      proves: "A package containing discovered TypeScript production source has a project configuration at the expected package boundary.",
      limitations: [
        "Does not prove that the TypeScript configuration is semantically correct for the package.",
        "Does not prove that the project typechecks.",
      ],
    },
    detect: missingTypeScriptConfigFindings,
  },
  {
    id: "typescript-source-test",
    version: 2,
    description:
      "Production TypeScript source is deterministically reachable from a test or matching test artifact",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "structural",
      oracle: "typescript-static-test-reachability",
      independenceKey: "static-test-reachability",
      proves: "A production TypeScript source file has mechanically discoverable matching-test or transitive static test-reachability evidence.",
      limitations: [
        "Does not prove that the test asserts useful behavior.",
        "Does not resolve bare imports, unresolved aliases, dynamic imports, or other relationships outside the conservative graph contract.",
      ],
    },
    detect: missingTestFindings,
  },
  {
    id: "typescript-type-assignability",
    version: 1,
    description:
      "TypeScript compiler assignment-compatibility diagnostics are exposed as deterministic evidence",
    defaultSeverity: "warning",
    policyKind: "advisory",
    evidenceContract: {
      basis: "semantic",
      oracle: "typescript-compiler",
      independenceKey: "typescript-compiler",
      proves: "The pinned TypeScript compiler emitted TS2322 assignment-compatibility diagnostics for the analyzed project state.",
      limitations: [
        "Does not independently confirm diagnostics already emitted by the same TypeScript compiler invocation.",
        "Does not prove runtime correctness or that a particular repair is semantically correct.",
      ],
    },
    detect: typeScriptAssignabilityFindings,
  },
];
expectationDescriptors.sort((left, right) => left.id.localeCompare(right.id));

export function expectationRegistry(): ExpectationRegistryRecord[] {
  return expectationDescriptors.map(({ detect: _detect, ...descriptor }) => ({ ...descriptor }));
}
