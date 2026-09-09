export const NORMALIZED_EVIDENCE_SCHEMA_VERSION = 1;

export const PACKAGE_SCRIPT_CANDIDATES = Object.freeze({
  "format:check": ["format:check", "check:format"],
  lint: ["lint"],
  typecheck: ["typecheck", "check-types"],
  build: ["build"],
  test: ["test"],
  "test:unit": ["test:unit", "test"],
  "test:integration": ["test:integration"],
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
  const base = {
    productionPathCount: productionPaths.length,
    testPathCount: testPaths.length,
    productionPaths,
    testPaths,
  };
  if (!input.complete) return { ...base, status: "incomplete", reason: "evidence-incomplete" };
  if (productionPaths.length === 0)
    return { ...base, status: "unsupported", reason: "no-production-source" };
  if (testPaths.length > 0)
    return { ...base, status: "satisfied", reason: "separate-test-path-present" };
  if (input.kind === "rust")
    return { ...base, status: "unsupported", reason: "rust-inline-tests-unobservable" };
  return { ...base, status: "finding", reason: "no-separate-test-path" };
}

export function remoteValidationOutcome(input) {
  const workflowPaths = [...new Set(input.workflowPaths ?? [])].toSorted();
  const externalCiPaths = [...new Set(input.externalCiPaths ?? [])].toSorted();
  const declaredCommands = [...new Set(input.declaredCommands ?? [])].filter(Boolean).toSorted();
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

function analyzeWorkflowValidation(input) {
  const relevantTrigger = workflowHasRelevantTrigger(input.content, input.defaultBranch);
  const matchedCommands = input.declaredCommands.filter((command) =>
    workflowRunsCommand(input.content, command),
  );
  const codingToolingAction = workflowUsesCodingToolingAction(
    input.content,
    input.localActionIsCodingTooling,
  );
  const validationInvocation = matchedCommands.length > 0 || codingToolingAction;
  return {
    path: input.path,
    status: relevantTrigger && validationInvocation ? "satisfied" : "finding",
    relevantTrigger,
    validationInvocation,
    matchedCommands,
    codingToolingAction,
  };
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

function workflowRunsCommand(content, command) {
  const needle = normalizeCommand(command);
  if (!needle) return false;
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const match = raw.match(/^(\s*)-?\s*run\s*:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[2].trim();
    if (inline && !new Set(["|", ">", "|-", ">-", "|+", ">+"]).has(inline)) {
      if (shellCommandMatches(inline, needle)) return true;
      continue;
    }
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockRaw = lines[blockIndex];
      if (!blockRaw.trim()) continue;
      const blockIndent = blockRaw.match(/^\s*/)?.[0].length ?? 0;
      if (blockIndent <= indent) break;
      const shellLine = blockRaw.trim();
      if (shellLine.startsWith("#")) continue;
      if (shellCommandMatches(shellLine, needle)) return true;
    }
  }
  return false;
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
