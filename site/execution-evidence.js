const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const BLOCK_MARKERS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);
const FINDING_RANK = { high: 0, medium: 1, low: 2, info: 3 };

export function applyExecutionEvidence(analysis, snapshot) {
  const workflows = workflowContents(snapshot);
  const expectedToolchains = expectedRepositoryToolchains(analysis, snapshot);
  const toolchains = toolchainConsistency(expectedToolchains, workflows);
  const dependencyResolution = dependencyResolutionEvidence(snapshot, workflows);
  const failClosed = failClosedValidationEvidence(analysis.validationEvidence, workflows);
  const validationEvidence = strengthenValidationEvidence(analysis.validationEvidence, failClosed);
  const executionEvidence = {
    schemaVersion: 1,
    basis: "structural",
    source: "github-workflow-text",
    toolchains,
    dependencyResolution,
    failClosed,
    limitations: [
      "Only explicit literal workflow values and commands are evaluated; expressions and opaque wrappers remain unknown.",
      "This evidence does not execute workflows or prove runtime, dependency, or application correctness.",
    ],
  };
  const findings = [...analysis.findings, ...executionFindings(executionEvidence)].toSorted(
    (left, right) =>
      FINDING_RANK[left.severity] - FINDING_RANK[right.severity] || left.id.localeCompare(right.id),
  );
  const highPriorityFindingCount = findings.filter((finding) => finding.severity === "high").length;
  const status =
    analysis.summary.status === "incomplete"
      ? "incomplete"
      : highPriorityFindingCount > 0
        ? "needs-attention"
        : "ready";

  return {
    ...analysis,
    summary: {
      ...analysis.summary,
      status,
      findingCount: findings.length,
      highPriorityFindingCount,
    },
    validationEvidence,
    executionEvidence,
    findings,
  };
}

export function remoteExecutionEvidence(input) {
  const workflows = new Map(
    (input.workflows ?? [])
      .filter((workflow) => workflow?.path && typeof workflow.content === "string")
      .map((workflow) => [workflow.path, workflow.content]),
  );
  return {
    schemaVersion: 1,
    basis: "structural",
    source: "github-workflow-text",
    toolchains: toolchainConsistency(input.expectedToolchains ?? {}, workflows),
    dependencyResolution: dependencyResolutionEvidence(
      { tree: (input.lockfiles ?? []).map((path) => ({ type: "blob", path })) },
      workflows,
    ),
    failClosed: failClosedValidationEvidence(input.validationEvidence, workflows),
  };
}

function executionFindings(evidence) {
  const findings = [];
  if (evidence.toolchains.status === "finding") {
    findings.push({
      id: "REMOTE-EXECUTION-TOOLCHAIN",
      severity: "high",
      title: "Hosted execution contradicts the repository toolchain",
      evidence: evidence.toolchains.mismatches
        .map(
          (item) =>
            `${item.workflow}: ${item.runtime} expects ${item.expected}, observed ${item.observed}`,
        )
        .join("; "),
      recommendation:
        "Align explicit hosted workflow runtime declarations with the repository-owned exact toolchain pin.",
    });
  }
  if (evidence.dependencyResolution.status === "finding") {
    findings.push({
      id: "REMOTE-EXECUTION-LOCK",
      severity: "high",
      title: "Hosted execution can change committed dependency resolution",
      evidence: evidence.dependencyResolution.violations
        .map((item) => `${item.workflow}: ${item.command} (${item.lockfile})`)
        .join("; "),
      recommendation:
        "Use the ecosystem's deterministic lock-consuming command on the existing hosted execution path.",
    });
  }
  if (evidence.failClosed.status === "finding") {
    findings.push({
      id: "REMOTE-CI-FAIL-CLOSED",
      severity: "high",
      title: "Validation evidence is explicitly fail-open",
      evidence: evidence.failClosed.suppressed
        .map((item) => `${item.workflow}: ${item.reason}`)
        .join("; "),
      recommendation:
        "Let validation failures propagate normally; do not use explicitly suppressed validation as merge evidence.",
    });
  }
  return findings;
}

function workflowContents(snapshot) {
  return new Map(
    Object.entries(snapshot.files ?? {})
      .filter(
        ([path, content]) =>
          /^\.github\/workflows\/.+\.ya?ml$/i.test(path) && typeof content === "string",
      )
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function expectedRepositoryToolchains(analysis, snapshot) {
  const result = {};
  const rootPackage = analysis.components?.find(
    (component) => component.kind === "package" && component.path === ".",
  );
  if (
    rootPackage?.toolchain?.status === "satisfied" &&
    EXACT_VERSION.test(rootPackage.toolchain.version ?? "")
  ) {
    const runtime = rootPackage.toolchain.runtime;
    if (runtime === "node" || runtime === "bun") result[runtime] = rootPackage.toolchain.version;
  }
  const rustSource = snapshot.files?.["rust-toolchain.toml"];
  if (typeof rustSource === "string") {
    const version = rustSource.match(/^\s*channel\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
    if (EXACT_VERSION.test(version ?? "")) result.rust = version;
  }
  return result;
}

function toolchainConsistency(expected, workflows) {
  const observations = [];
  for (const [workflow, content] of workflows) {
    for (const observation of workflowToolchainObservations(content)) {
      observations.push({ workflow, ...observation });
    }
  }
  observations.sort(observationOrder);
  const relevant = observations.filter((item) => typeof expected[item.runtime] === "string");
  const mismatches = relevant
    .filter(
      (item) => !EXACT_VERSION.test(item.observed) || item.observed !== expected[item.runtime],
    )
    .map((item) => ({ ...item, expected: expected[item.runtime] }));
  if (mismatches.length > 0) {
    return { status: "finding", expected, observations, mismatches };
  }
  if (Object.keys(expected).length === 0 || relevant.length === 0) {
    return {
      status: "unsupported",
      expected,
      observations,
      mismatches: [],
      reason:
        Object.keys(expected).length === 0
          ? "no-exact-repository-toolchain"
          : "no-literal-workflow-toolchain",
    };
  }
  return { status: "satisfied", expected, observations, mismatches: [] };
}

function workflowToolchainObservations(content) {
  const observations = [];
  const lines = String(content).split(/\r?\n/);
  for (const raw of lines) {
    const line = stripYamlComment(raw).trim();
    if (!line) continue;
    const field = line.match(/^(node[-_]version|bun[-_]version|rust[-_]version)\s*:\s*(.+)$/i);
    if (field) {
      const runtime = field[1].toLowerCase().startsWith("node")
        ? "node"
        : field[1].toLowerCase().startsWith("bun")
          ? "bun"
          : "rust";
      const observed = literalScalar(field[2]);
      if (observed) observations.push({ runtime, observed, source: field[1] });
      continue;
    }
    const rustAction =
      line.match(/^uses\s*:\s*dtolnay\/rust-toolchain@([^\s]+)$/i) ??
      line.match(/^-\s*uses\s*:\s*dtolnay\/rust-toolchain@([^\s]+)$/i);
    if (rustAction) {
      const observed = literalScalar(rustAction[1]);
      if (
        observed &&
        (EXACT_VERSION.test(observed) || /^(?:stable|beta|nightly)$/i.test(observed))
      ) {
        observations.push({ runtime: "rust", observed, source: "dtolnay/rust-toolchain" });
      }
    }
  }
  return observations;
}

function dependencyResolutionEvidence(snapshot, workflows) {
  const paths = new Set(
    (snapshot.tree ?? []).filter((entry) => entry?.type === "blob").map((entry) => entry.path),
  );
  const lockKinds = [
    ["package-lock.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["Cargo.lock", "cargo"],
  ].filter(([path]) => paths.has(path));
  const observations = [];
  const violations = [];
  for (const [workflow, content] of workflows) {
    for (const command of workflowCommands(content)) {
      for (const [lockfile, manager] of lockKinds) {
        const outcome = frozenResolutionOutcome(manager, command);
        if (!outcome) continue;
        const observation = { workflow, manager, lockfile, command, ...outcome };
        observations.push(observation);
        if (outcome.status === "finding") violations.push(observation);
      }
    }
  }
  observations.sort(commandObservationOrder);
  violations.sort(commandObservationOrder);
  if (violations.length > 0) return { status: "finding", observations, violations };
  if (lockKinds.length === 0 || observations.length === 0) {
    return {
      status: "unsupported",
      observations,
      violations,
      reason:
        lockKinds.length === 0 ? "no-supported-root-lockfile" : "no-literal-resolution-command",
    };
  }
  return { status: "satisfied", observations, violations };
}

function frozenResolutionOutcome(manager, command) {
  const value = normalizeCommand(command);
  if (manager === "npm") {
    if (/^npm\s+(?:install|i)\s+(?:-g|--global)(?:\s|$)/.test(value)) return null;
    if (/^npm\s+ci(?:\s|$)/.test(value)) return { status: "satisfied", reason: "npm-ci" };
    if (/^npm\s+(?:install|i)(?:\s|$)/.test(value))
      return { status: "finding", reason: "npm-install-can-resolve" };
    return null;
  }
  if (manager === "bun") {
    if (!/^bun\s+install(?:\s|$)/.test(value)) return null;
    return value.includes("--frozen-lockfile")
      ? { status: "satisfied", reason: "bun-frozen-lockfile" }
      : { status: "finding", reason: "bun-install-not-frozen" };
  }
  if (manager === "pnpm") {
    if (!/^pnpm\s+install(?:\s|$)/.test(value)) return null;
    return value.includes("--frozen-lockfile")
      ? { status: "satisfied", reason: "pnpm-frozen-lockfile" }
      : { status: "finding", reason: "pnpm-install-not-frozen" };
  }
  if (manager === "yarn") {
    if (!/^yarn\s+install(?:\s|$)/.test(value)) return null;
    return value.includes("--immutable") || value.includes("--frozen-lockfile")
      ? { status: "satisfied", reason: "yarn-immutable" }
      : { status: "finding", reason: "yarn-install-not-frozen" };
  }
  if (manager === "cargo") {
    if (!/^cargo\s+(?:build|check|clippy|test|bench|package)(?:\s|$)/.test(value)) return null;
    return value.split(/\s+/).includes("--locked")
      ? { status: "satisfied", reason: "cargo-locked" }
      : { status: "finding", reason: "cargo-command-not-locked" };
  }
  return null;
}

function failClosedValidationEvidence(validationEvidence, workflows) {
  const validating = new Set(validationEvidence?.validatingWorkflowPaths ?? []);
  if (validating.size === 0) {
    return {
      status: "unsupported",
      examined: [],
      suppressed: [],
      reason: "no-proven-validation-workflow",
    };
  }
  const examined = [];
  const suppressed = [];
  for (const workflowEvidence of validationEvidence.workflowEvidence ?? []) {
    if (!validating.has(workflowEvidence.path)) continue;
    const content = workflows.get(workflowEvidence.path);
    if (typeof content !== "string") continue;
    const result = failClosedWorkflow(workflowEvidence, content);
    examined.push({ workflow: workflowEvidence.path, ...result });
    if (result.status === "finding") {
      suppressed.push({
        workflow: workflowEvidence.path,
        reason: result.reason,
      });
    }
  }
  examined.sort((left, right) => left.workflow.localeCompare(right.workflow));
  suppressed.sort((left, right) => left.workflow.localeCompare(right.workflow));
  if (suppressed.length === validating.size && examined.length === validating.size) {
    return {
      status: "finding",
      examined,
      suppressed,
      reason: "all-proven-validation-is-fail-open",
    };
  }
  if (examined.some((item) => item.status === "satisfied")) {
    return { status: "satisfied", examined, suppressed };
  }
  return {
    status: "unsupported",
    examined,
    suppressed,
    reason: "fail-closed-step-mapping-incomplete",
  };
}

function failClosedWorkflow(workflowEvidence, content) {
  const steps = workflowSteps(content);
  let mapped = false;
  let unsuppressed = false;
  let explicitlySuppressed = false;
  for (const step of steps) {
    const matchedCommandEvidence = workflowEvidence.matchedCommandEvidence ?? [];
    const commandMatch =
      matchedCommandEvidence.length > 0
        ? matchedCommandEvidence.some(
            (command) =>
              step.workingDirectory === command.workingDirectory &&
              step.commands.some((candidate) => shellCommandMatches(candidate, command.command)),
          )
        : (workflowEvidence.matchedCommands ?? []).some((command) =>
            step.commands.some((candidate) => shellCommandMatches(candidate, command)),
          );
    const actionMatch = workflowEvidence.codingToolingAction && step.codingToolingAction;
    if (!commandMatch && !actionMatch) continue;
    mapped = true;
    if (step.continueOnError || step.commands.some(obviousShellSuppression))
      explicitlySuppressed = true;
    else unsuppressed = true;
  }
  if (unsuppressed) return { status: "satisfied", reason: "validation-fails-closed" };
  if (mapped && explicitlySuppressed) {
    return { status: "finding", reason: "validation-step-explicitly-suppresses-failure" };
  }
  return { status: "unsupported", reason: "validation-step-not-mapped" };
}

function strengthenValidationEvidence(validationEvidence, failClosed) {
  if (validationEvidence?.status !== "satisfied" || failClosed.status !== "finding") {
    return { ...validationEvidence, failClosed };
  }
  return {
    ...validationEvidence,
    status: "finding",
    reason: "validation-evidence-not-fail-closed",
    validatingWorkflowPaths: [],
    failClosed,
  };
}

function workflowSteps(content) {
  const lines = String(content).split(/\r?\n/);
  const steps = [];
  for (let sectionIndex = 0; sectionIndex < lines.length; sectionIndex += 1) {
    const section = lines[sectionIndex].match(/^(\s*)steps\s*:\s*(?:#.*)?$/);
    if (!section) continue;
    const sectionIndent = section[1].length;
    let stepIndent = null;
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      const raw = lines[index];
      if (!raw.trim()) continue;
      const indent = raw.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= sectionIndent) break;
      const start = raw.match(/^(\s*)-\s+.+$/);
      if (!start) continue;
      if (stepIndent === null) stepIndent = indent;
      if (indent !== stepIndent) continue;

      let end = lines.length;
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextRaw = lines[next];
        if (!nextRaw.trim()) continue;
        const nextIndent = nextRaw.match(/^\s*/)?.[0].length ?? 0;
        if (nextIndent <= sectionIndent) {
          end = next;
          break;
        }
        if (nextIndent === stepIndent && /^\s*-\s+/.test(nextRaw)) {
          end = next;
          break;
        }
      }

      const block = lines.slice(index, end);
      const commands = workflowCommands(block.join("\n"));
      const continueOnError = block.some((line) =>
        /^\s*continue-on-error\s*:\s*true\s*(?:#.*)?$/i.test(line),
      );
      const codingToolingAction =
        block.some((line) =>
          /^\s*(?:-\s*)?uses\s*:\s*(?:moritzbrantner\/coding-tooling@[^\s#]+|\.\/?)(?:\s+#.*)?$/i.test(
            line,
          ),
        ) &&
        !block.some((line) =>
          /^operation\s*:\s*(?!run\s*$)[^#]+/i.test(stripYamlComment(line).trim()),
        );
      const workingDirectory = workflowStepWorkingDirectory(block);
      if (commands.length || codingToolingAction) {
        steps.push({ commands, continueOnError, codingToolingAction, workingDirectory });
      }
      index = Math.max(index, end - 1);
    }
  }
  return steps;
}

function workflowStepWorkingDirectory(block) {
  for (const raw of block) {
    const match = stripYamlComment(raw).match(/^\s*working-directory\s*:\s*(.+)$/);
    if (!match) continue;
    const value = literalScalar(match[1]);
    if (!value) return null;
    const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
    return normalized || ".";
  }
  return ".";
}

function workflowCommands(content) {
  const commands = [];
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = stripYamlComment(lines[index]);
    const match = raw.match(/^(\s*)(?:-\s*)?(run|[A-Za-z0-9_-]+_command)\s*:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[3].trim();
    if (inline && !BLOCK_MARKERS.has(inline)) {
      const value = literalCommand(inline);
      if (value) commands.push(value);
      continue;
    }
    if (match[2] !== "run") continue;
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockRaw = lines[blockIndex];
      if (!blockRaw.trim()) continue;
      const blockIndent = blockRaw.match(/^\s*/)?.[0].length ?? 0;
      if (blockIndent <= indent) break;
      const value = stripYamlComment(blockRaw).trim();
      if (value) commands.push(value);
    }
  }
  return [...new Set(commands)].toSorted();
}

function literalCommand(value) {
  const scalar = literalScalar(value);
  if (!scalar || scalar.includes("${{")) return null;
  return scalar;
}

function literalScalar(value) {
  let result = String(value ?? "").trim();
  if (!result || result.includes("${{")) return null;
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1).trim();
  }
  return result || null;
}

function obviousShellSuppression(value) {
  const normalized = normalizeCommand(value);
  return /\|\|\s*(?:true|:)\s*$/.test(normalized);
}

function shellCommandMatches(value, command) {
  const candidate = normalizeCommand(value);
  const needle = normalizeCommand(command);
  return candidate === needle || candidate.startsWith(`${needle} `);
}

function stripYamlComment(value) {
  return String(value).replace(/\s+#.*$/, "");
}

function normalizeCommand(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function observationOrder(left, right) {
  return (
    left.workflow.localeCompare(right.workflow) ||
    left.runtime.localeCompare(right.runtime) ||
    left.source.localeCompare(right.source) ||
    left.observed.localeCompare(right.observed)
  );
}

function commandObservationOrder(left, right) {
  return (
    left.workflow.localeCompare(right.workflow) ||
    left.manager.localeCompare(right.manager) ||
    left.command.localeCompare(right.command)
  );
}
