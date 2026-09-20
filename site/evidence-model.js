import { discoverReusableWorkflowCalls, materializeReusableWorkflow } from "./reusable-workflow.js";

export const NORMALIZED_EVIDENCE_SCHEMA_VERSION = 1;

export const PACKAGE_SCRIPT_CANDIDATES = Object.freeze({
  "format:check": ["format:check", "check:format"],
  lint: ["lint"],
  typecheck: ["typecheck", "check-types"],
  build: ["build"],
  test: ["test"],
  "test:unit": ["test:unit", "test"],
  "test:integration": ["test:integration"],
  "test:integration:workflow": ["test:integration:workflow"],
  "test:e2e": ["test:e2e"],
  "test:e2e:smoke": ["test:e2e:smoke"],
  "test:accessibility": ["test:accessibility"],
  "test:visual": ["test:visual"],
  "package:check": ["package:check"],
  "dependencies:audit": ["dependencies:audit", "audit:dependencies"],
  benchmark: ["benchmark", "bench"],
  "benchmark:smoke": ["benchmark:smoke", "bench:smoke"],
  "profile:runtime": ["profile:runtime"],
  "profile:hotspots": ["profile:hotspots"],
  "profile:memory": ["profile:memory"],
  "storybook:check": ["storybook:check"],
  "web:audit": ["web:audit"],
  "template:smoke": ["template:smoke"],
});

const TECHNOLOGY_DEPENDENCIES = Object.freeze([
  ["react", "react"],
  ["next", "nextjs"],
  ["vite", "vite"],
  ["vitest", "vitest"],
]);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function strings(value) {
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([, item]) => typeof item === "string")
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function provenance(collector, path) {
  return { collector, path };
}

export function createPackageEvidence(input) {
  const collector = input.collector;
  if (collector !== "filesystem" && collector !== "github") {
    throw new Error(`Unsupported package evidence collector: ${String(collector)}`);
  }
  const manifestPath = input.manifestPath;
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new Error("Package evidence requires a manifest path");
  }
  const path = input.path || ".";
  const scripts = strings(input.scripts);
  const dependencies = strings(input.dependencies);
  const devDependencies = strings(input.devDependencies);
  const lockfiles = [
    ...new Set((input.lockfiles ?? []).filter((item) => typeof item === "string")),
  ].toSorted();
  const packageManager = typeof input.packageManager === "string" ? input.packageManager : null;
  const nodeVersion = typeof input.nodeVersion === "string" ? input.nodeVersion.trim() : null;
  const nodeVersionPath = input.nodeVersionPath ?? `${path === "." ? "" : `${path}/`}.node-version`;

  return {
    schemaVersion: NORMALIZED_EVIDENCE_SCHEMA_VERSION,
    component: {
      name: input.name,
      path,
      kind: "package",
    },
    facts: {
      manifest: {
        status: "available",
        path: manifestPath,
        provenance: provenance(collector, manifestPath),
      },
      scripts: {
        status: "available",
        value: scripts,
        provenance: provenance(collector, manifestPath),
      },
      dependencies: {
        status: "available",
        value: dependencies,
        provenance: provenance(collector, manifestPath),
      },
      devDependencies: {
        status: "available",
        value: devDependencies,
        provenance: provenance(collector, manifestPath),
      },
      packageManager: {
        status: packageManager === null ? "incomplete" : "available",
        value: packageManager,
        provenance: provenance(collector, manifestPath),
      },
      nodeVersion: {
        status: nodeVersion === null ? "incomplete" : "available",
        value: nodeVersion,
        provenance: provenance(collector, nodeVersionPath),
      },
      tsconfig: {
        status: "available",
        value: Boolean(input.hasTsconfig),
        provenance: provenance(
          collector,
          input.tsconfigPath ?? `${path === "." ? "" : `${path}/`}tsconfig.json`,
        ),
      },
      lockfiles: {
        status: "available",
        value: lockfiles,
        provenance: lockfiles.map((item) =>
          provenance(collector, path === "." ? item : `${path}/${item}`),
        ),
      },
    },
  };
}

export function packageSemantics(evidence) {
  if (evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported normalized package evidence schema");
  }
  const dependencies = {
    ...record(evidence.facts.dependencies.value),
    ...record(evidence.facts.devDependencies.value),
  };
  const technologies = ["javascript"];
  if (evidence.facts.tsconfig.value) technologies.push("typescript");
  for (const [dependency, technology] of TECHNOLOGY_DEPENDENCIES) {
    if (dependency in dependencies) technologies.push(technology);
  }
  if (
    Object.keys(dependencies).some(
      (dependency) => dependency === "storybook" || dependency.startsWith("@storybook/"),
    )
  ) {
    technologies.push("storybook");
  }
  if ("lighthouse" in dependencies || "@lhci/cli" in dependencies) {
    technologies.push("lighthouse");
  }

  const scripts = record(evidence.facts.scripts.value);
  const declaredCapabilities = {};
  for (const [capability, candidates] of Object.entries(PACKAGE_SCRIPT_CANDIDATES)) {
    const script = candidates.find((candidate) => candidate in scripts);
    if (script) declaredCapabilities[capability] = script;
  }

  return {
    technologies,
    declaredCapabilities,
  };
}

export function packageCommandManager(evidence) {
  if (evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported normalized package evidence schema");
  }
  const packageManager = evidence.facts.packageManager.value;
  if (typeof packageManager === "string") {
    if (packageManager.startsWith("bun@")) return "bun";
    if (packageManager.startsWith("npm@")) return "npm";
    if (packageManager.startsWith("pnpm@") || packageManager.startsWith("yarn@")) return null;
  }
  if (
    evidence.facts.lockfiles.value.includes("bun.lock") ||
    evidence.facts.lockfiles.value.includes("bun.lockb")
  ) {
    return "bun";
  }
  return "npm";
}

export function packageToolchainOutcome(evidence) {
  if (evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported normalized package evidence schema");
  }
  const packageManager = evidence.facts.packageManager.value;
  if (typeof packageManager === "string") {
    const match = packageManager.match(/^([^@]+)@(.+)$/);
    if (!match) {
      return {
        status: "unsupported",
        manager: null,
        runtime: null,
        reason: "package-manager-format-unsupported",
        provenance: [evidence.facts.packageManager.provenance],
      };
    }
    const manager = match[1];
    const version = match[2];
    if (manager === "bun") {
      return {
        status: EXACT_VERSION.test(version) ? "satisfied" : "finding",
        manager: "bun",
        runtime: "bun",
        version,
        reason: EXACT_VERSION.test(version) ? "exact-bun-version" : "bun-version-not-exact",
        provenance: [evidence.facts.packageManager.provenance],
      };
    }
    if (manager !== "npm") {
      return {
        status: "unsupported",
        manager,
        runtime: null,
        version,
        reason: "package-manager-unsupported",
        provenance: [evidence.facts.packageManager.provenance],
      };
    }
  }

  const nodeVersion = evidence.facts.nodeVersion.value;
  if (typeof nodeVersion === "string") {
    return {
      status: EXACT_VERSION.test(nodeVersion) ? "satisfied" : "finding",
      manager: packageCommandManager(evidence),
      runtime: "node",
      version: nodeVersion,
      reason: EXACT_VERSION.test(nodeVersion) ? "exact-node-version" : "node-version-not-exact",
      provenance: [evidence.facts.nodeVersion.provenance],
    };
  }

  return {
    status: "incomplete",
    manager: packageCommandManager(evidence),
    runtime:
      evidence.facts.lockfiles.value.includes("bun.lock") ||
      evidence.facts.lockfiles.value.includes("bun.lockb")
        ? "bun"
        : "node",
    version: null,
    reason:
      evidence.facts.lockfiles.value.includes("bun.lock") ||
      evidence.facts.lockfiles.value.includes("bun.lockb")
        ? "bun-version-missing"
        : "node-version-missing",
    provenance: [evidence.facts.packageManager.provenance, evidence.facts.nodeVersion.provenance],
  };
}

export function canonicalPackageCapabilityOutcomes(
  evidence,
  required = ["format:check", "lint", "typecheck", "test:unit"],
) {
  if (evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported normalized package evidence schema");
  }
  if (
    evidence.facts.manifest.status !== "available" ||
    evidence.facts.scripts.status !== "available"
  ) {
    return required.map((capability) => ({
      capability,
      status: "incomplete",
      provenance: [evidence.facts.manifest.provenance],
    }));
  }
  const { declaredCapabilities } = packageSemantics(evidence);
  return required.map((capability) => ({
    capability,
    status: declaredCapabilities[capability] ? "satisfied" : "finding",
    ...(declaredCapabilities[capability] ? { script: declaredCapabilities[capability] } : {}),
    provenance: [evidence.facts.scripts.provenance],
  }));
}

export function structuralTestOutcome(input) {
  const productionPaths = [...new Set(input.productionPaths ?? [])].toSorted();
  const testPaths = [...new Set(input.testPaths ?? [])].toSorted();
  const inlineTestPaths = [...new Set(input.inlineTestPaths ?? [])].toSorted();
  const inspectedSourcePaths = [...new Set(input.inspectedSourcePaths ?? [])].toSorted();
  const base = {
    productionPathCount: productionPaths.length,
    testPathCount: testPaths.length,
    inlineTestPathCount: inlineTestPaths.length,
    inspectedSourcePathCount: inspectedSourcePaths.length,
    productionPaths,
    testPaths,
    inlineTestPaths,
    inspectedSourcePaths,
  };
  if (!input.complete) return { ...base, status: "incomplete", reason: "evidence-incomplete" };
  if (productionPaths.length === 0)
    return { ...base, status: "unsupported", reason: "no-production-source" };
  if (testPaths.length > 0)
    return { ...base, status: "satisfied", reason: "separate-test-path-present" };
  if (input.kind === "rust") {
    if (inlineTestPaths.length > 0)
      return { ...base, status: "satisfied", reason: "rust-inline-test-evidence-present" };
    if (!input.sourceContentComplete)
      return { ...base, status: "incomplete", reason: "rust-source-content-incomplete" };
    return { ...base, status: "finding", reason: "no-rust-test-evidence" };
  }
  return { ...base, status: "finding", reason: "no-separate-test-path" };
}

export function remoteValidationOutcome(input) {
  const workflowPaths = [...new Set(input.workflowPaths ?? [])].toSorted();
  const externalCiPaths = [...new Set(input.externalCiPaths ?? [])].toSorted();
  const declaredCommands = normalizeDeclaredCommands(input.declaredCommands);
  const packageScripts = normalizePackageScripts(input.packageScripts);
  const loaded = new Map(
    (input.workflows ?? [])
      .filter((workflow) => workflow?.path && typeof workflow.content === "string")
      .map((workflow) => [workflow.path, workflow.content]),
  );
  const workflowEvidence = workflowPaths
    .filter((path) => loaded.has(path))
    .map((path) =>
      analyzeWorkflowValidation({
        path,
        content: loaded.get(path),
        defaultBranch: input.defaultBranch,
        declaredCommands,
        packageScripts,
        reusableWorkflows: (input.reusableWorkflows ?? []).filter(
          (workflow) => workflow.callerPath === path,
        ),
        localActionIsCodingTooling: Boolean(input.localActionIsCodingTooling),
      }),
    );
  const validatingWorkflowPaths = workflowEvidence
    .filter((workflow) => workflow.status === "satisfied")
    .map((workflow) => workflow.path)
    .toSorted();
  const base = {
    automation: workflowPaths.length || externalCiPaths.length ? "present" : "absent",
    githubWorkflowPaths: workflowPaths,
    externalCiPaths,
    examinedWorkflowPaths: [...loaded.keys()].toSorted(),
    validatingWorkflowPaths,
    workflowEvidence,
  };
  if (validatingWorkflowPaths.length > 0)
    return {
      ...base,
      status: "satisfied",
      provider: "github-actions",
      reason: "validation-workflow-evidenced",
    };
  const missingWorkflowContent = workflowPaths.some((path) => !loaded.has(path));
  if (input.workflowFetchTruncated || missingWorkflowContent)
    return {
      ...base,
      status: "incomplete",
      provider: "github-actions",
      reason: "workflow-content-incomplete",
    };
  if (
    input.reusableWorkflowEvidenceIncomplete ||
    workflowEvidence.some((workflow) => workflow.status === "incomplete")
  )
    return {
      ...base,
      status: "incomplete",
      provider: "github-actions",
      reason: "reusable-workflow-evidence-incomplete",
    };
  if (externalCiPaths.length > 0)
    return {
      ...base,
      status: "unsupported",
      provider: workflowPaths.length ? "mixed" : "external",
      reason: "external-ci-validation-not-evaluated",
    };
  if (workflowPaths.length > 0)
    return {
      ...base,
      status: "finding",
      provider: "github-actions",
      reason: "automation-without-validation-evidence",
    };
  return { ...base, status: "finding", provider: "none", reason: "no-ci-config" };
}

function normalizeDeclaredCommands(values) {
  const commands = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const command = normalizeCommand(typeof value === "string" ? value : value?.command);
    const workingDirectory = normalizeWorkingDirectory(
      typeof value === "string" ? "." : value?.workingDirectory,
    );
    if (!command || workingDirectory === null) continue;
    const key = `${workingDirectory}\0${command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push({ command, workingDirectory });
  }
  return commands.toSorted(
    (left, right) =>
      left.workingDirectory.localeCompare(right.workingDirectory) ||
      left.command.localeCompare(right.command),
  );
}

function normalizePackageScripts(values) {
  return (values ?? [])
    .flatMap((value) => {
      const workingDirectory = normalizeWorkingDirectory(value?.workingDirectory ?? ".");
      const manager = value?.manager === "bun" || value?.manager === "npm" ? value.manager : null;
      const scripts = strings(value?.scripts);
      if (workingDirectory === null || manager === null || Object.keys(scripts).length === 0) {
        return [];
      }
      return [{ workingDirectory, manager, scripts }];
    })
    .toSorted(
      (left, right) =>
        left.workingDirectory.localeCompare(right.workingDirectory) ||
        left.manager.localeCompare(right.manager),
    );
}

function analyzeWorkflowValidation(input) {
  const relevantTrigger = workflowHasRelevantTrigger(input.content, input.defaultBranch);
  const direct = workflowValidationCommandEvidence(input.content, input);
  const reusableWorkflowEvidence = (input.reusableWorkflows ?? []).map((workflow) =>
    analyzeReusableWorkflowValidation(workflow, input),
  );
  const matchedPackageScriptEvidence = [
    ...direct.matchedPackageScriptEvidence,
    ...reusableWorkflowEvidence.flatMap((workflow) => workflow.matchedPackageScriptEvidence ?? []),
  ];
  const wrapperMatchedCommandKeys = new Set(
    matchedPackageScriptEvidence.flatMap((evidence) =>
      evidence.matchedCommands.map((command) => `${evidence.workingDirectory}\0${command}`),
    ),
  );
  const matchedCommandEvidence = input.declaredCommands.filter(
    (command) =>
      direct.literalMatchedCommandEvidence.some(
        (literal) =>
          literal.command === command.command &&
          literal.workingDirectory === command.workingDirectory,
      ) ||
      reusableWorkflowEvidence.some((workflow) =>
        (workflow.matchedCommandEvidence ?? []).some(
          (matched) =>
            matched.command === command.command &&
            matched.workingDirectory === command.workingDirectory,
        ),
      ) ||
      wrapperMatchedCommandKeys.has(`${command.workingDirectory}\0${command.command}`),
  );
  const matchedCommands = [
    ...new Set(matchedCommandEvidence.map((command) => command.command)),
  ].toSorted();
  const codingToolingAction = direct.codingToolingAction;
  const validationInvocation = matchedCommandEvidence.length > 0 || codingToolingAction;
  const reusableIncomplete = reusableWorkflowEvidence.some((workflow) =>
    ["incomplete", "unsupported"].includes(workflow.status),
  );
  return {
    path: input.path,
    status:
      relevantTrigger && validationInvocation
        ? "satisfied"
        : relevantTrigger && reusableIncomplete
          ? "incomplete"
          : "finding",
    relevantTrigger,
    validationInvocation,
    matchedCommands,
    matchedCommandEvidence,
    matchedPackageScriptEvidence,
    codingToolingAction,
    reusableWorkflowEvidence,
  };
}

function analyzeReusableWorkflowValidation(workflow, input) {
  const base = {
    callerPath: workflow.callerPath,
    job: workflow.job,
    reference: workflow.target.reference,
    repository: workflow.repository ?? workflow.target.repository,
    path: workflow.path ?? workflow.target.path,
    ref: workflow.ref ?? workflow.target.ref,
  };
  if (workflow.status !== "resolved") {
    return {
      ...base,
      status: workflow.status === "unsupported" ? "unsupported" : "incomplete",
      reason: workflow.reason ?? "reusable-workflow-content-unavailable",
      validationInvocation: false,
      matchedCommands: [],
      matchedCommandEvidence: [],
      matchedPackageScriptEvidence: [],
    };
  }

  const materialized = materializeReusableWorkflow(workflow.content, workflow.inputs);
  if (!materialized.workflowCall) {
    return {
      ...base,
      status: "unsupported",
      reason: "target-is-not-a-reusable-workflow",
      validationInvocation: false,
      matchedCommands: [],
      matchedCommandEvidence: [],
      matchedPackageScriptEvidence: [],
    };
  }
  const evidence = workflowValidationCommandEvidence(materialized.content, {
    ...input,
    localActionIsCodingTooling:
      workflow.target.status === "local" && input.localActionIsCodingTooling,
  });
  const matchedCommands = [
    ...new Set(evidence.matchedCommandEvidence.map((command) => command.command)),
  ].toSorted();
  const validationInvocation = matchedCommands.length > 0 || evidence.codingToolingAction;
  const nestedReusableWorkflow =
    discoverReusableWorkflowCalls([{ path: workflow.path, content: materialized.content }]).length >
    0;
  return {
    ...base,
    status: validationInvocation
      ? "satisfied"
      : materialized.unresolvedInputs.length > 0 || nestedReusableWorkflow
        ? "incomplete"
        : "finding",
    reason: validationInvocation
      ? "validation-command-evidenced"
      : materialized.unresolvedInputs.length > 0 || nestedReusableWorkflow
        ? materialized.unresolvedInputs.length > 0
          ? "reusable-workflow-inputs-unresolved"
          : "nested-reusable-workflow-unresolved"
        : "no-validation-command-evidenced",
    validationInvocation,
    matchedCommands,
    matchedCommandEvidence: evidence.matchedCommandEvidence,
    matchedPackageScriptEvidence: evidence.matchedPackageScriptEvidence,
    unresolvedInputs: materialized.unresolvedInputs,
    nestedReusableWorkflow,
  };
}

function workflowValidationCommandEvidence(content, input) {
  const literalMatchedCommandEvidence = input.declaredCommands.filter((command) =>
    workflowRunsCommand(content, command),
  );
  const matchedPackageScriptEvidence = input.packageScripts.flatMap((packageEvidence) =>
    workflowPackageScriptValidationEvidence(content, packageEvidence, input.declaredCommands),
  );
  const wrapperMatchedCommandKeys = new Set(
    matchedPackageScriptEvidence.flatMap((evidence) =>
      evidence.matchedCommands.map((command) => `${evidence.workingDirectory}\0${command}`),
    ),
  );
  const matchedCommandEvidence = input.declaredCommands.filter(
    (command) =>
      literalMatchedCommandEvidence.some(
        (literal) =>
          literal.command === command.command &&
          literal.workingDirectory === command.workingDirectory,
      ) || wrapperMatchedCommandKeys.has(`${command.workingDirectory}\0${command.command}`),
  );
  return {
    literalMatchedCommandEvidence,
    matchedCommandEvidence,
    matchedPackageScriptEvidence,
    codingToolingAction: workflowUsesCodingToolingAction(content, input.localActionIsCodingTooling),
  };
}

function workflowPackageScriptValidationEvidence(content, packageEvidence, declaredCommands) {
  const declared = declaredCommands.filter(
    (command) => command.workingDirectory === packageEvidence.workingDirectory,
  );
  if (declared.length === 0) return [];
  const results = [];
  for (const script of Object.keys(packageEvidence.scripts).toSorted()) {
    const wrapperCommand = `${packageEvidence.manager} run ${script}`;
    if (
      !workflowRunsCommand(
        content,
        {
          command: wrapperCommand,
          workingDirectory: packageEvidence.workingDirectory,
        },
        packageScriptInvocationMatchesInDirectory,
      )
    ) {
      continue;
    }
    const matchedCommands = resolvePackageScriptValidation(
      packageEvidence.scripts,
      packageEvidence.manager,
      script,
      declared,
    );
    if (matchedCommands.length === 0) continue;
    results.push({
      command: wrapperCommand,
      script,
      workingDirectory: packageEvidence.workingDirectory,
      matchedCommands,
    });
  }
  return results.toSorted(
    (left, right) =>
      left.workingDirectory.localeCompare(right.workingDirectory) ||
      left.command.localeCompare(right.command),
  );
}

function resolvePackageScriptValidation(
  scripts,
  manager,
  script,
  declaredCommands,
  seen = new Set(),
) {
  if (seen.has(script) || seen.size >= 16) return [];
  const source = scripts[script];
  if (typeof source !== "string" || !source.trim()) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(script);
  const segments = boundedPackageScriptSegments(source);
  if (segments.length === 0) return [];
  const matches = new Set();
  for (const segment of segments) {
    let bounded = false;
    for (const declared of declaredCommands) {
      if (!packageScriptDeclaredCommandMatches(segment, declared.command, manager)) continue;
      matches.add(declared.command);
      bounded = true;
    }
    const referencedScript = packageScriptReference(segment, manager);
    if (!referencedScript) {
      if (!bounded) return [];
      continue;
    }
    if (typeof scripts[referencedScript] !== "string" || !scripts[referencedScript].trim())
      return [];
    const canonicalReference = `${manager} run ${referencedScript}`;
    const declaredReference = declaredCommands.some(
      (declared) => declared.command === canonicalReference,
    );
    if (declaredReference) {
      matches.add(canonicalReference);
      bounded = true;
    }
    const nestedMatches = resolvePackageScriptValidation(
      scripts,
      manager,
      referencedScript,
      declaredCommands,
      nextSeen,
    );
    if (!declaredReference && nestedMatches.length === 0) return [];
    for (const matched of nestedMatches) matches.add(matched);
    bounded = true;
    if (!bounded) return [];
  }
  return [...matches].toSorted();
}

function packageScriptDeclaredCommandMatches(segment, command, manager) {
  const packageScriptCommand =
    command.startsWith(`${manager} run `) ||
    (manager === "npm" && /^npm\s+(?:test|start|stop|restart)$/.test(command));
  return packageScriptCommand
    ? packageScriptInvocationMatches(segment, command)
    : shellCommandMatches(segment, command);
}

function boundedPackageScriptSegments(source) {
  const value = String(source).trim();
  if (!value || /[;|`\n\r]/.test(value) || /(^|[^&])&([^&]|$)/.test(value) || value.includes("$("))
    return [];
  return value
    .split(/\s*&&\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function packageScriptReference(segment, manager) {
  const run = segment.match(
    new RegExp(`^${manager}\\s+run\\s+([A-Za-z0-9:_-]+)(?:\\s+--(?:\\s+.*)?)?$`),
  );
  if (run) return run[1];
  if (manager === "npm") {
    const shorthand = segment.match(/^npm\s+(test|start|stop|restart)(?:\s+--(?:\s+.*)?)?$/);
    if (shorthand) return shorthand[1];
  }
  return null;
}

function workflowHasRelevantTrigger(content, defaultBranch) {
  const lines = normalizedYamlLines(content);
  const onIndex = lines.findIndex((line) => /^on\s*:/.test(line.text));
  if (onIndex === -1) return false;
  const first = lines[onIndex];
  const inline = first.text.replace(/^on\s*:\s*/, "");
  if (inline) {
    if (/\bpull_request(?:_target)?\b/.test(inline)) return true;
    if (/\bpush\b/.test(inline)) return true;
    return false;
  }
  const block = [];
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.indent <= first.indent && /^[A-Za-z0-9_."'-]+\s*:/.test(line.text)) break;
    block.push(line);
  }
  if (block.some((line) => /^pull_request(?:_target)?\s*:/.test(line.text))) return true;
  const pushIndex = block.findIndex((line) => /^push\s*:/.test(line.text));
  if (pushIndex === -1) return false;
  const push = block[pushIndex];
  const pushInline = push.text.replace(/^push\s*:\s*/, "");
  if (pushInline) return inlinePushRelevant(pushInline, defaultBranch);
  const pushBlock = [];
  for (let index = pushIndex + 1; index < block.length; index += 1) {
    const line = block[index];
    if (line.indent <= push.indent) break;
    pushBlock.push(line);
  }
  const branchesIndex = pushBlock.findIndex((line) => /^branches\s*:/.test(line.text));
  if (branchesIndex === -1)
    return !pushBlock.some((line) => /^branches-ignore\s*:/.test(line.text));
  const branch = pushBlock[branchesIndex];
  const branchInline = branch.text.replace(/^branches\s*:\s*/, "");
  if (branchInline) return yamlListValues(branchInline).includes(defaultBranch);
  for (let index = branchesIndex + 1; index < pushBlock.length; index += 1) {
    const line = pushBlock[index];
    if (line.indent <= branch.indent) break;
    const value = line.text.match(/^-\s*["']?([^"'#]+?)["']?\s*$/)?.[1]?.trim();
    if (value === defaultBranch) return true;
  }
  return false;
}

function inlinePushRelevant(value, defaultBranch) {
  const trimmed = String(value).trim();
  if (trimmed === "{}") return true;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const body = trimmed.slice(1, -1);
  const branches = body.match(/(?:^|,)\s*branches\s*:\s*(\[[^\]]*\])/);
  if (branches) return yamlListValues(branches[1]).includes(defaultBranch);
  const ignored = body.match(/(?:^|,)\s*branches-ignore\s*:\s*(\[[^\]]*\])/);
  if (ignored) return !yamlListValues(ignored[1]).includes(defaultBranch);
  return true;
}

function workflowRunsCommand(
  content,
  declaredCommand,
  matchesInDirectory = shellCommandMatchesInDirectory,
) {
  const needle = normalizeCommand(declaredCommand?.command ?? declaredCommand);
  const requiredWorkingDirectory = normalizeWorkingDirectory(
    declaredCommand?.workingDirectory ?? ".",
  );
  if (!needle || requiredWorkingDirectory === null) return false;
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const match = raw.match(/^(\s*)-?\s*run\s*:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const workingDirectory = workflowRunWorkingDirectory(lines, index, indent);
    const inline = match[2].trim();
    if (inline && !new Set(["|", ">", "|-", ">-", "|+", ">+"]).has(inline)) {
      if (matchesInDirectory(inline, needle, workingDirectory, requiredWorkingDirectory))
        return true;
      continue;
    }
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockRaw = lines[blockIndex];
      if (!blockRaw.trim()) continue;
      const blockIndent = blockRaw.match(/^\s*/)?.[0].length ?? 0;
      if (blockIndent <= indent) break;
      const shellLine = blockRaw.trim();
      if (shellLine.startsWith("#")) continue;
      if (matchesInDirectory(shellLine, needle, workingDirectory, requiredWorkingDirectory))
        return true;
    }
  }
  return false;
}

function workflowRunWorkingDirectory(lines, runIndex, runIndent) {
  let stepStart = runIndex;
  let stepIndent = runIndent;
  if (!/^(\s*)-\s*run\s*:/.test(lines[runIndex])) {
    for (let index = runIndex - 1; index >= 0; index -= 1) {
      const raw = lines[index];
      if (!raw.trim()) continue;
      const indent = raw.match(/^\s*/)?.[0].length ?? 0;
      if (/^\s*-\s+/.test(raw) && indent < runIndent) {
        stepStart = index;
        stepIndent = indent;
        break;
      }
      if (indent < runIndent) break;
    }
  }

  let end = lines.length;
  for (let index = stepStart + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    if (indent < stepIndent || (indent === stepIndent && /^\s*-\s+/.test(raw))) {
      end = index;
      break;
    }
  }

  for (const raw of lines.slice(stepStart, end)) {
    const match = raw.match(/^\s*working-directory\s*:\s*(.+)$/);
    if (!match) continue;
    return normalizeWorkingDirectory(match[1]);
  }
  return (
    workflowJobDefaultWorkingDirectory(lines, runIndex) ??
    workflowDefaultWorkingDirectory(lines) ??
    "."
  );
}

function workflowJobDefaultWorkingDirectory(lines, runIndex) {
  const jobsIndex = lines.findIndex((line) => /^\s*jobs\s*:\s*(?:#.*)?$/.test(line));
  if (jobsIndex < 0 || jobsIndex >= runIndex) return null;
  const jobsIndent = yamlIndent(lines[jobsIndex]);
  const starts = [];
  let jobsEnd = lines.length;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const indent = yamlIndent(raw);
    if (indent <= jobsIndent) {
      jobsEnd = index;
      break;
    }
    const match = raw.match(/^(\s*)[A-Za-z0-9_.-]+\s*:\s*(?:#.*)?$/);
    if (!match) continue;
    if (starts.length === 0 || indent === starts[0].indent) starts.push({ index, indent });
  }
  const position = starts.findLastIndex((start) => start.index <= runIndex);
  const job = starts[position];
  if (!job) return null;
  const jobEnd = starts[position + 1]?.index ?? jobsEnd;
  return defaultRunWorkingDirectory(lines, job.index + 1, jobEnd, job.indent);
}

function workflowDefaultWorkingDirectory(lines) {
  const jobsIndex = lines.findIndex((line) => /^\s*jobs\s*:/.test(line));
  const end = jobsIndex < 0 ? lines.length : jobsIndex;
  return defaultRunWorkingDirectory(lines, 0, end, -1);
}

function defaultRunWorkingDirectory(lines, start, end, parentIndent) {
  const defaultsIndex = findYamlProperty(lines, start, end, parentIndent, "defaults");
  if (defaultsIndex < 0) return null;
  const defaultsIndent = yamlIndent(lines[defaultsIndex]);
  const defaultsEnd = yamlBlockEnd(lines, defaultsIndex, end);
  const runIndex = findYamlProperty(lines, defaultsIndex + 1, defaultsEnd, defaultsIndent, "run");
  if (runIndex < 0) return null;
  const runIndent = yamlIndent(lines[runIndex]);
  const runEnd = yamlBlockEnd(lines, runIndex, defaultsEnd);
  const directoryIndex = findYamlProperty(
    lines,
    runIndex + 1,
    runEnd,
    runIndent,
    "working-directory",
  );
  if (directoryIndex < 0) return null;
  const match = lines[directoryIndex].match(/^\s*working-directory\s*:\s*(.+)$/);
  return match ? normalizeWorkingDirectory(match[1]) : null;
}

function findYamlProperty(lines, start, end, parentIndent, key) {
  let childIndent = null;
  for (let index = start; index < end; index += 1) {
    if (!lines[index].trim()) continue;
    const indent = yamlIndent(lines[index]);
    if (indent <= parentIndent) break;
    childIndent = childIndent === null ? indent : Math.min(childIndent, indent);
  }
  if (childIndent === null) return -1;
  for (let index = start; index < end; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const indent = yamlIndent(raw);
    if (indent <= parentIndent) break;
    if (indent === childIndent && new RegExp(`^\\s*${key}\\s*:`).test(raw)) return index;
  }
  return -1;
}

function yamlBlockEnd(lines, start, limit) {
  const indent = yamlIndent(lines[start]);
  for (let index = start + 1; index < limit; index += 1) {
    if (!lines[index].trim()) continue;
    if (yamlIndent(lines[index]) <= indent) return index;
  }
  return limit;
}

function yamlIndent(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function shellCommandMatchesInDirectory(value, command, workingDirectory, requiredDirectory) {
  if (workingDirectory === requiredDirectory && shellCommandMatches(value, command)) return true;
  if (workingDirectory !== "." || requiredDirectory === ".") return false;
  const normalized = normalizeCommand(value);
  const prefix = `cd ${requiredDirectory} && `;
  return (
    normalized.startsWith(prefix) && shellCommandMatches(normalized.slice(prefix.length), command)
  );
}

function packageScriptInvocationMatchesInDirectory(
  value,
  command,
  workingDirectory,
  requiredDirectory,
) {
  if (workingDirectory === requiredDirectory && packageScriptInvocationMatches(value, command))
    return true;
  if (workingDirectory !== "." || requiredDirectory === ".") return false;
  const normalized = normalizeCommand(value);
  const prefix = `cd ${requiredDirectory} && `;
  return (
    normalized.startsWith(prefix) &&
    packageScriptInvocationMatches(normalized.slice(prefix.length), command)
  );
}

function packageScriptInvocationMatches(value, command) {
  const normalized = normalizeCommand(value);
  if (normalized === command) return true;
  if (!normalized.startsWith(`${command} `)) return false;
  const suffix = normalized.slice(command.length).trimStart();
  return (
    suffix === "--" ||
    suffix.startsWith("-- ") ||
    suffix.startsWith("#") ||
    /^(?:&&|\|\|)(?:\s|$)/.test(suffix) ||
    /^&(?:\s|$)/.test(suffix)
  );
}

function normalizeWorkingDirectory(value) {
  let directory = String(value ?? ".").trim();
  if (!directory || directory === ".") return ".";
  if (directory.includes("${{")) return null;
  if (
    (directory.startsWith('"') && directory.endsWith('"')) ||
    (directory.startsWith("'") && directory.endsWith("'"))
  ) {
    directory = directory.slice(1, -1).trim();
  }
  directory = directory.replace(/^\.\//, "").replace(/\/$/, "");
  return directory || ".";
}

function shellCommandMatches(value, command) {
  const normalized = normalizeCommand(value);
  return normalized === command || normalized.startsWith(`${command} `);
}

function workflowUsesCodingToolingAction(content, localActionIsCodingTooling) {
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const match = raw.match(/^(\s*)-\s*uses\s*:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (!match) continue;
    const reference = match[2];
    const external = /^moritzbrantner\/coding-tooling@[^\s#]+$/.test(reference);
    const local = localActionIsCodingTooling && /^\.\/?$/.test(reference);
    if (!external && !local) continue;

    const stepIndent = match[1].length;
    let operation = null;
    let withIndent = null;
    for (let stepIndex = index + 1; stepIndex < lines.length; stepIndex += 1) {
      const stepRaw = lines[stepIndex];
      if (!stepRaw.trim()) continue;
      const indent = stepRaw.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= stepIndent && /^\s*-\s*/.test(stepRaw)) break;
      if (indent <= stepIndent) break;
      const trimmed = stepRaw.trim();
      if (/^with\s*:\s*$/.test(trimmed)) {
        withIndent = indent;
        continue;
      }
      if (withIndent === null || indent <= withIndent) continue;
      const operationMatch = trimmed.match(/^operation\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/);
      if (operationMatch) operation = operationMatch[1].trim();
    }
    if (operation === null || operation === "run") return true;
  }
  return false;
}

function normalizedYamlLines(content) {
  return String(content)
    .split(/\r?\n/)
    .map((raw) => {
      const withoutComment = raw.replace(/\s+#.*$/, "").replace(/\t/g, "  ");
      return { indent: withoutComment.match(/^\s*/)?.[0].length ?? 0, text: withoutComment.trim() };
    })
    .filter((line) => line.text);
}

function yamlListValues(value) {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function normalizeCommand(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}
