import { analyzeFindingsCoverage, type FindingsCoverage } from "./expectation-coverage.ts";
import { applyGeneratorPlan } from "./generator-apply.ts";
import {
  createDetectorContext,
  expectationDescriptors,
  expectationRegistry,
  type ExpectationDescriptor,
  type RawFinding,
} from "./expectation-detectors.ts";
import {
  duplicateValues,
  findingIdPattern,
  loadExpectationConfig,
  matchingSuppression,
  semanticFindingId,
  writeExpectationConfig,
  type ExpectationConfig,
  type ExpectationEnvelope,
  type ExpectationSuppression,
  type ExpectationVerification,
  type Finding,
  type FindingState,
  type FindingVerificationEvidence,
  type ReconciliationReport,
} from "./expectation-model.ts";
import type { DetectorContext, PackageInfo } from "./expectation-package-context.ts";
import type { GeneratorPlan } from "./generators.ts";

export { expectationRegistry, loadExpectationConfig };
export type {
  DetectorCoverage,
  DetectorCoverageStatus,
  FindingsCoverage,
} from "./expectation-coverage.ts";
export type {
  ExpectationConfig,
  ExpectationEnvelope,
  ExpectationOperation,
  ExpectationRegistryEntry,
  ExpectationSuppression,
  ExpectationVerification,
  Finding,
  FindingDisposition,
  FindingEvidence,
  FindingRelationship,
  FindingRelationshipKind,
  FindingRequirement,
  FindingScaffold,
  FindingSeverity,
  FindingState,
  FindingSubject,
  FindingVerificationEvidence,
  ReconciliationReport,
  RepositoryInvariant,
} from "./expectation-model.ts";

const supportedVerificationManagers = new Set(["bun", "npm", "pnpm", "yarn"]);

function materializeFinding(
  descriptor: ExpectationDescriptor,
  raw: RawFinding,
  config: ExpectationConfig,
): Finding {
  const id = semanticFindingId(
    descriptor.id,
    descriptor.version,
    raw.subject.key,
    raw.requirement.key,
  );
  const suppression = matchingSuppression(
    { id, expectationId: descriptor.id, subject: raw.subject },
    config,
  );
  return {
    ...raw,
    id,
    expectationId: descriptor.id,
    expectationVersion: descriptor.version,
    policyKind: descriptor.policyKind,
    conventionId: descriptor.conventionId,
    severity: config.enforcement?.[descriptor.id] ?? descriptor.defaultSeverity,
    state: config.baseline?.includes(id) ? "baseline" : "new",
    disposition: suppression ? "suppressed" : "active",
    suppressionReason: suppression?.reason,
    relationships: [],
  };
}

function addRelationships(findings: Finding[]): Finding[] {
  const bySubject = new Map<string, Finding[]>();
  for (const finding of findings) {
    const current = bySubject.get(finding.subject.key) ?? [];
    current.push(finding);
    bySubject.set(finding.subject.key, current);
  }
  return findings.map((finding) => ({
    ...finding,
    relationships: (bySubject.get(finding.subject.key) ?? [])
      .filter((other) => other.id !== finding.id)
      .map((other) => ({ kind: "same-subject" as const, targetId: other.id }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId)),
  }));
}

function suppressionMatchesFinding(suppression: ExpectationSuppression, finding: Finding): boolean {
  if (suppression.id && suppression.id !== finding.id) return false;
  if (suppression.expectation && suppression.expectation !== finding.expectationId) return false;
  if (suppression.subject && suppression.subject !== finding.subject.key) return false;
  return true;
}

function verificationMatchesFinding(
  verification: ExpectationVerification,
  finding: Finding,
): boolean {
  return (
    verification.expectation === finding.expectationId &&
    verification.subject === finding.subject.key
  );
}

function packageOwnsSubject(packageInfo: PackageInfo, subjectPath: string): boolean {
  if (packageInfo.path === ".") return true;
  return subjectPath === packageInfo.path || subjectPath.startsWith(`${packageInfo.path}/`);
}

function owningPackage(context: DetectorContext, finding: Finding): PackageInfo | undefined {
  const subjectPath = finding.subject.path ?? finding.subject.key;
  return context.packages
    .filter((packageInfo) => packageOwnsSubject(packageInfo, subjectPath))
    .reduce<PackageInfo | undefined>(
      (best, candidate) =>
        best === undefined || candidate.path.length > best.path.length ? candidate : best,
      undefined,
    );
}

function validateVerificationCommand(
  verification: ExpectationVerification,
  finding: Finding,
  context: DetectorContext,
): string | undefined {
  const [manager, run, script] = verification.command;
  if (!manager || !supportedVerificationManagers.has(manager) || run !== "run" || !script) {
    return "command must use bun/npm/pnpm/yarn run <script>";
  }
  const packageInfo = owningPackage(context, finding);
  if (!packageInfo) return "finding subject is not owned by a discovered package";
  const configured = packageInfo.manifest.scripts?.[script];
  if (typeof configured !== "string" || !configured.trim()) {
    return `package ${packageInfo.path} does not expose scripts.${script}`;
  }
  return undefined;
}

type VerificationResolution = {
  evidenceByFindingId: Map<string, FindingVerificationEvidence>;
  staleVerifications: Array<{ index: number; id: string }>;
  invalidVerifications: Array<{ index: number; id: string; reason: string }>;
  duplicateVerifications: number[];
  unknownExpectations: string[];
};

function resolveVerifications(
  config: ExpectationConfig,
  allFindings: Finding[],
  context: DetectorContext,
): VerificationResolution {
  const knownExpectations = new Set(expectationDescriptors.map((descriptor) => descriptor.id));
  const evidenceByFindingId = new Map<string, FindingVerificationEvidence>();
  const staleVerifications: Array<{ index: number; id: string }> = [];
  const invalidVerifications: Array<{ index: number; id: string; reason: string }> = [];
  const duplicateVerifications: number[] = [];
  const unknownExpectations = new Set<string>();
  const seenIds = new Set<string>();
  const seenSubjects = new Set<string>();

  for (const [index, verification] of (config.verifications ?? []).entries()) {
    const subjectKey = `${verification.expectation}\0${verification.subject}`;
    if (seenIds.has(verification.id) || seenSubjects.has(subjectKey)) {
      duplicateVerifications.push(index);
      continue;
    }
    seenIds.add(verification.id);
    seenSubjects.add(subjectKey);

    if (!knownExpectations.has(verification.expectation)) {
      unknownExpectations.add(verification.expectation);
      continue;
    }
    const finding = allFindings.find((candidate) =>
      verificationMatchesFinding(verification, candidate),
    );
    if (!finding) {
      staleVerifications.push({ index, id: verification.id });
      continue;
    }
    if (finding.disposition === "suppressed") {
      invalidVerifications.push({
        index,
        id: verification.id,
        reason:
          "finding is also suppressed; remove suppression before declaring verification evidence",
      });
      continue;
    }
    const invalid = validateVerificationCommand(verification, finding, context);
    if (invalid) {
      invalidVerifications.push({ index, id: verification.id, reason: invalid });
      continue;
    }
    evidenceByFindingId.set(finding.id, {
      id: verification.id,
      version: verification.version,
      command: verification.command,
      reason: verification.reason,
    });
  }

  return {
    evidenceByFindingId,
    staleVerifications,
    invalidVerifications,
    duplicateVerifications,
    unknownExpectations: [...unknownExpectations].sort(),
  };
}

function applyVerificationEvidence(
  findings: Finding[],
  resolution: VerificationResolution,
): Finding[] {
  return findings.map((finding) => {
    const verificationEvidence = resolution.evidenceByFindingId.get(finding.id);
    if (!verificationEvidence) return finding;
    return {
      ...finding,
      disposition: "verified" as const,
      suppressionReason: undefined,
      verificationEvidence,
    };
  });
}

function reconcile(
  config: ExpectationConfig,
  allFindings: Finding[],
  verificationResolution: VerificationResolution,
): ReconciliationReport {
  const allIds = new Set(allFindings.map((finding) => finding.id));
  const knownExpectations = new Set(expectationDescriptors.map((descriptor) => descriptor.id));
  const unknownExpectations = new Set<string>(verificationResolution.unknownExpectations);
  for (const expectation of Object.keys(config.enforcement ?? {})) {
    if (!knownExpectations.has(expectation)) unknownExpectations.add(expectation);
  }
  for (const suppression of config.suppressions ?? []) {
    if (suppression.expectation && !knownExpectations.has(suppression.expectation)) {
      unknownExpectations.add(suppression.expectation);
    }
  }

  const staleSuppressions = (config.suppressions ?? []).flatMap((suppression, index) =>
    allFindings.some((finding) => suppressionMatchesFinding(suppression, finding))
      ? []
      : [{ index, reason: suppression.reason }],
  );

  const seenSuppressions = new Set<string>();
  const duplicateSuppressions: number[] = [];
  for (const [index, suppression] of (config.suppressions ?? []).entries()) {
    const key = `${suppression.id ?? ""}\0${suppression.expectation ?? ""}\0${suppression.subject ?? ""}`;
    if (seenSuppressions.has(key)) duplicateSuppressions.push(index);
    seenSuppressions.add(key);
  }

  return {
    orphanedBaseline: [...new Set(config.baseline ?? [])].filter((id) => !allIds.has(id)).sort(),
    staleSuppressions,
    staleVerifications: verificationResolution.staleVerifications,
    invalidVerifications: verificationResolution.invalidVerifications,
    unknownExpectations: [...unknownExpectations].sort(),
    duplicateBaseline: duplicateValues(config.baseline ?? []),
    duplicateSuppressions,
    duplicateVerifications: verificationResolution.duplicateVerifications,
    duplicateInvariants: duplicateValues(
      (config.invariants ?? []).map((invariant) => invariant.id),
    ),
  };
}

export function analyzeExpectations(
  root: string,
  options: { includeSuppressed?: boolean } = {},
): {
  findings: Finding[];
  config: ExpectationConfig;
  reconciliation: ReconciliationReport;
  coverage: FindingsCoverage;
} {
  const config = loadExpectationConfig(root);
  const context = createDetectorContext(root);
  const materialized = expectationDescriptors
    .flatMap((descriptor) =>
      descriptor.detect(context).map((raw) => materializeFinding(descriptor, raw, config)),
    )
    .sort(
      (left, right) =>
        left.subject.key.localeCompare(right.subject.key) ||
        left.expectationId.localeCompare(right.expectationId) ||
        left.id.localeCompare(right.id),
    );
  const verificationResolution = resolveVerifications(config, materialized, context);
  const allFindings = applyVerificationEvidence(materialized, verificationResolution);
  const reconciliation = reconcile(config, allFindings, verificationResolution);
  const coverage = analyzeFindingsCoverage(root, context, expectationDescriptors);
  const visible = options.includeSuppressed
    ? allFindings
    : allFindings.filter((finding) => finding.disposition === "active");
  return { findings: addRelationships(visible), config, reconciliation, coverage };
}

function findingCounts(findings: Finding[]): Record<string, number> {
  return {
    total: findings.length,
    active: findings.filter((finding) => finding.disposition === "active").length,
    suppressed: findings.filter((finding) => finding.disposition === "suppressed").length,
    verified: findings.filter((finding) => finding.disposition === "verified").length,
    new: findings.filter((finding) => finding.state === "new").length,
    baseline: findings.filter((finding) => finding.state === "baseline").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    error: findings.filter((finding) => finding.severity === "error").length,
  };
}

export function findingsCommand(
  root: string,
  options: { state?: FindingState; includeSuppressed?: boolean } = {},
): ExpectationEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root, { includeSuppressed: options.includeSuppressed });
    const findings = options.state
      ? analysis.findings.filter((finding) => finding.state === options.state)
      : analysis.findings;
    const blocking = analysis.findings.some(
      (finding) =>
        finding.disposition === "active" && finding.state === "new" && finding.severity === "error",
    );
    return {
      schemaVersion: 1,
      operation: "findings",
      status: blocking ? "failed" : "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        state: options.state ?? "all",
        includeSuppressed: options.includeSuppressed === true,
        registry: expectationRegistry(),
        coverage: analysis.coverage,
        counts: findingCounts(findings),
        findings,
        invariants: analysis.config.invariants ?? [],
        reconciliation: analysis.reconciliation,
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "findings",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, findings: [] },
      diagnostics: [
        {
          code: "invalid-expectations",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export function findingCommand(root: string, id: string): ExpectationEnvelope {
  const started = Date.now();
  if (!findingIdPattern.test(id)) {
    return {
      schemaVersion: 1,
      operation: "finding",
      status: "unavailable",
      durationMs: Date.now() - started,
      data: { root, id, result: "absent" },
      diagnostics: [{ code: "invalid-finding-id", message: `Invalid finding ID: ${id}` }],
    };
  }
  try {
    const analysis = analyzeExpectations(root, { includeSuppressed: true });
    const finding = analysis.findings.find((item) => item.id === id);
    return {
      schemaVersion: 1,
      operation: "finding",
      status: "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        id,
        result: finding?.disposition ?? "absent",
        finding,
        coverage: analysis.coverage,
        reconciliation: analysis.reconciliation,
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "finding",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, id },
      diagnostics: [
        {
          code: "finding-lookup-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export function baselineFindings(root: string): ExpectationEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root);
    const baseline = analysis.findings.map((finding) => finding.id).sort();
    writeExpectationConfig(root, { ...analysis.config, baseline });
    return {
      schemaVersion: 1,
      operation: "baseline",
      status: "passed",
      durationMs: Date.now() - started,
      data: { root, baselineCount: baseline.length, baseline },
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "baseline",
      status: "error",
      durationMs: Date.now() - started,
      data: { root },
      diagnostics: [
        {
          code: "baseline-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function scaffoldPlan(finding: Finding): GeneratorPlan {
  if (!finding.scaffold) throw new Error(`Finding ${finding.id} has no deterministic scaffold`);
  const generator = `finding:${finding.id}`;
  return {
    generator,
    inputs: {},
    target: ".",
    operations: [
      {
        generator,
        kind: "create-file",
        template: generator,
        path: finding.scaffold.path,
        content: finding.scaffold.content,
      },
    ],
    prerequisites: [],
    postconditions: [],
  };
}

export function scaffoldFinding(root: string, id: string): ExpectationEnvelope {
  const started = Date.now();
  try {
    const analysis = analyzeExpectations(root);
    const finding = analysis.findings.find((item) => item.id === id);
    if (!finding) {
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "unavailable",
        durationMs: Date.now() - started,
        data: { root, id },
        diagnostics: [{ code: "finding-not-found", message: `Finding ${id} is not active` }],
      };
    }
    if (!finding.scaffold) {
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "unavailable",
        durationMs: Date.now() - started,
        data: { root, id, finding },
        diagnostics: [
          { code: "scaffold-unavailable", message: `Finding ${id} has no deterministic scaffold` },
        ],
      };
    }

    const generation = applyGeneratorPlan(root, scaffoldPlan(finding));
    if (generation.result !== "generated" && generation.result !== "no-op") {
      return {
        schemaVersion: 1,
        operation: "scaffold",
        status: "failed",
        durationMs: Date.now() - started,
        data: { root, id, finding, generation },
        diagnostics: generation.diagnostics,
      };
    }

    const remaining = analyzeExpectations(root).findings.some((item) => item.id === id);
    return {
      schemaVersion: 1,
      operation: "scaffold",
      status: remaining ? "failed" : "passed",
      durationMs: Date.now() - started,
      data: {
        root,
        id,
        path: finding.scaffold.path,
        result: remaining ? "still-active" : "scaffolded",
        generation,
      },
      diagnostics: remaining
        ? [
            {
              code: "scaffold-incomplete",
              message: `Finding ${id} remains active after scaffolding`,
            },
          ]
        : [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "scaffold",
      status: "error",
      durationMs: Date.now() - started,
      data: { root, id },
      diagnostics: [
        {
          code: "scaffold-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
