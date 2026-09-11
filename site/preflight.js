import {
  canonicalPackageCapabilityOutcomes,
  createPackageEvidence,
  packageCommandManager,
  packageSemantics,
  packageToolchainOutcome,
  remoteValidationOutcome,
  structuralTestOutcome,
} from "./evidence-model.js";
import { resolveWorkspacePackages, workspaceToolchainConflict } from "./workspace-toolchain.js";

const CONTEXT_FILES = new Set([".coding-tooling.json", ".node-version", "rust-toolchain.toml"]);
const IGNORED_ANALYSIS_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "generated",
  "node_modules",
  "target",
  "vendor",
]);

export function parseRepositoryReference(value) {
  const input = value.trim();
  const short = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) return { owner: short[1], name: short[2] };

  try {
    const url = new URL(input);
    if (!["github.com", "www.github.com"].includes(url.hostname)) return null;
    const [owner, rawName] = url.pathname.split("/").filter(Boolean);
    if (!owner || !rawName) return null;
    return { owner, name: rawName.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

export function selectedWorkflowFiles(tree, limit = 8) {
  return tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        /^\.github\/workflows\/.+\.ya?ml$/i.test(entry.path) &&
        !isIgnoredAnalysisPath(entry.path),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .slice(0, limit);
}

export function selectedRemoteFiles(tree, limit = 24) {
  return tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        !isIgnoredAnalysisPath(entry.path) &&
        (basename(entry.path) === "package.json" ||
          basename(entry.path) === ".node-version" ||
          CONTEXT_FILES.has(entry.path)),
    )
    .toSorted(
      (left, right) =>
        priority(left.path) - priority(right.path) || left.path.localeCompare(right.path),
    )
    .slice(0, limit);
}

export function analyzeSnapshot(snapshot, now = new Date()) {
  const paths = new Set(
    snapshot.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
  );
  const config = parseJson(snapshot.files[".coding-tooling.json"]);
  const components = applyConfiguredCapabilities(discoverComponents(snapshot, paths), config);
  const technologies = [
    ...new Set(components.flatMap((component) => component.technologies)),
  ].toSorted();
  const validationEvidence = validationEvidenceFor(snapshot, paths, components);
  const findings = findingsFor(snapshot, paths, components, validationEvidence);
  const incomplete =
    snapshot.treeTruncated ||
    snapshot.manifestFetchTruncated ||
    snapshot.unreadablePaths.length > 0 ||
    validationEvidence.status === "incomplete";
  const highPriorityFindingCount = findings.filter((finding) => finding.severity === "high").length;

  return {
    schemaVersion: 1,
    operation: "remote-preflight",
    generatedAt: now.toISOString(),
    source: {
      provider: "github",
      repository: snapshot.repository.fullName,
      defaultBranch: snapshot.repository.defaultBranch,
      treeTruncated: snapshot.treeTruncated,
      manifestFetchTruncated: snapshot.manifestFetchTruncated,
      workflowFetchTruncated: Boolean(snapshot.workflowFetchTruncated),
      unreadablePaths: snapshot.unreadablePaths,
      analyzedFiles: Object.keys(snapshot.files).length,
    },
    repository: snapshot.repository,
    summary: {
      status: incomplete ? "incomplete" : highPriorityFindingCount ? "needs-attention" : "ready",
      componentCount: components.length,
      technologyCount: technologies.length,
      findingCount: findings.length,
      highPriorityFindingCount,
    },
    technologies,
    components,
    validationEvidence,
    findings,
    limitations: [
      "Remote preflight reads GitHub metadata, a recursive tree, and bounded text manifests; it does not clone or execute repository code.",
      "Findings are structural evidence, not claims about behavioral correctness, security, coverage, or runtime performance.",
      "Run coding-tooling locally for authoritative conformance, findings, environment verification, and validation execution.",
    ],
    agentHandoff: {
      purpose:
        "Continue from remote structural evidence to authoritative local deterministic analysis.",
      localCommands: [
        `git clone https://github.com/${snapshot.repository.fullName}.git`,
        `cd ${snapshot.repository.name}`,
        "coding-tooling inspect --json",
        "coding-tooling bootstrap plan --json",
        "coding-tooling conformance --json",
        "coding-tooling findings --json",
        "coding-tooling plan --tier fast --json",
      ],
    },
  };
}

function discoverComponents(snapshot, paths) {
  const components = [];
  for (const entry of snapshot.tree.filter(
    (candidate) =>
      basename(candidate.path) === "package.json" && !isIgnoredAnalysisPath(candidate.path),
  )) {
    const manifest = parseJson(snapshot.files[entry.path]);
    if (!manifest) continue;
    const directory = dirname(entry.path);
    const path = directory || ".";
    const name = manifest.name ?? (path === "." ? snapshot.repository.name : basename(directory));
    const nodeVersionPath = joinPath(directory, ".node-version");
    const evidence = createPackageEvidence({
      collector: "github",
      name,
      path,
      manifestPath: entry.path,
      packageManager: manifest.packageManager,
      nodeVersion: snapshot.files[nodeVersionPath],
      nodeVersionPath,
      scripts: manifest.scripts,
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
      hasTsconfig: paths.has(joinPath(directory, "tsconfig.json")),
      tsconfigPath: joinPath(directory, "tsconfig.json"),
      lockfiles: ["bun.lock", "bun.lockb", "package-lock.json"].filter((lockfile) =>
        paths.has(joinPath(directory, lockfile)),
      ),
    });
    const semantics = packageSemantics(evidence);
    const manager = packageCommandManager(evidence);
    const toolchain = packageToolchainOutcome(evidence);
    const capabilities = manager
      ? Object.fromEntries(
          Object.entries(semantics.declaredCapabilities).map(([capability, script]) => [
            capability,
            manager === "bun" ? ["bun", "run", script] : ["npm", "run", script],
          ]),
        )
      : {};
    components.push({
      name,
      path,
      kind: "package",
      technologies: semantics.technologies,
      declaredCapabilities: semantics.declaredCapabilities,
      capabilities,
      toolchain,
      evidence,
    });
  }

  for (const entry of snapshot.tree.filter(
    (candidate) =>
      basename(candidate.path) === "Cargo.toml" && !isIgnoredAnalysisPath(candidate.path),
  )) {
    const directory = dirname(entry.path);
    components.push({
      name: directory ? basename(directory) : snapshot.repository.name,
      path: directory || ".",
      kind: "rust",
      technologies: ["rust"],
      capabilities: {
        "format:check": ["cargo", "fmt", "--check"],
        lint: ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"],
        build: ["cargo", "build", "--locked"],
        "test:unit": ["cargo", "test", "--locked", "--lib"],
      },
    });
  }

  for (const entry of snapshot.tree.filter(
    (candidate) => /\.(sln|csproj)$/.test(candidate.path) && !isIgnoredAnalysisPath(candidate.path),
  )) {
    const directory = dirname(entry.path);
    const path = directory || ".";
    if (components.some((component) => component.kind === "dotnet" && component.path === path))
      continue;
    components.push({
      name: directory ? basename(directory) : snapshot.repository.name,
      path,
      kind: "dotnet",
      technologies: ["dotnet"],
      capabilities: {
        "format:check": ["dotnet", "format", basename(entry.path), "--verify-no-changes"],
        build: ["dotnet", "build", basename(entry.path), "--no-restore"],
        "test:unit": ["dotnet", "test", basename(entry.path), "--no-build"],
      },
    });
  }

  const resolvedComponents = resolveWorkspacePackages(
    components,
    parseJson(snapshot.files["package.json"]),
  );
  const evidenceComplete = !(
    snapshot.treeTruncated ||
    snapshot.manifestFetchTruncated ||
    snapshot.unreadablePaths.length > 0
  );
  for (const component of resolvedComponents) {
    component.testEvidence = structuralTestOutcome({
      kind: component.kind,
      complete: evidenceComplete,
      productionPaths: componentOwnedPaths(
        paths,
        resolvedComponents,
        component,
        isProductionSource,
      ),
      testPaths: componentOwnedPaths(paths, resolvedComponents, component, isTestPath),
    });
  }

  return resolvedComponents.toSorted(
    (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
  );
}

function applyConfiguredCapabilities(components, config) {
  if (config?.schemaVersion !== 1) return components;
  return components.map((component) => {
    const configured = configuredCapabilities(config, component);
    if (Object.keys(configured).length === 0) return component;
    return {
      ...component,
      configuredCapabilities: configured,
      capabilities: { ...component.capabilities, ...configured },
    };
  });
}

function configuredCapabilities(config, component) {
  const capabilityCommands = record(config?.capabilityCommands);
  const byName = record(capabilityCommands[component.name]);
  const byPath = record(capabilityCommands[component.path]);
  return Object.fromEntries(
    Object.entries({ ...byName, ...byPath }).filter(([, command]) => validCommand(command)),
  );
}

function validCommand(command) {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === "string" && part.length > 0)
  );
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function findingsFor(snapshot, paths, components, validationEvidence) {
  const findings = [];
  const add = (id, severity, title, evidence, recommendation, command) =>
    findings.push({
      id,
      severity,
      title,
      evidence,
      recommendation,
      ...(command ? { command } : {}),
    });
  const config = parseJson(snapshot.files[".coding-tooling.json"]);
  if (!paths.has(".coding-tooling.json"))
    add(
      "REMOTE-FOUNDATION-001",
      "high",
      "coding-tooling foundation is missing",
      ".coding-tooling.json is absent.",
      "Inspect the bootstrap plan before applying repository foundations.",
      "coding-tooling bootstrap plan --json",
    );
  else if (config?.schemaVersion !== 1)
    add(
      "REMOTE-FOUNDATION-002",
      "high",
      "coding-tooling config could not be validated",
      ".coding-tooling.json is not readable as a schemaVersion 1 config.",
      "Validate or repair the local repository configuration.",
      "coding-tooling conformance --json",
    );

  if (validationEvidence.status === "finding" && validationEvidence.reason === "no-ci-config")
    add(
      "REMOTE-CI-001",
      "high",
      "No CI configuration detected",
      "No supported GitHub Actions or external CI configuration was found.",
      "Add deterministic CI around repository-declared validation capabilities.",
    );
  else if (
    validationEvidence.status === "finding" &&
    validationEvidence.reason === "automation-without-validation-evidence"
  )
    add(
      "REMOTE-CI-002",
      "high",
      "Automation exists without proven validation",
      `${validationEvidence.githubWorkflowPaths.length} GitHub Actions workflow file(s) exist, but none of the inspected workflows mechanically proves a relevant trigger plus a repository validation invocation.`,
      "Wire a repository-declared validation capability or coding-tooling action into pull-request or default-branch CI.",
    );
  else if (validationEvidence.status === "incomplete")
    add(
      "REMOTE-CI-003",
      "medium",
      "Remote CI validation evidence is incomplete",
      "Not every discovered GitHub Actions workflow could be inspected within the remote evidence boundary.",
      "Use local or hosted repository evidence before deciding whether validation is absent.",
    );

  const renovate = [...paths].some((path) =>
    ["renovate.json", "renovate.json5", ".github/renovate.json"].includes(path),
  );
  const dependabot = paths.has(".github/dependabot.yml") || paths.has(".github/dependabot.yaml");
  if (renovate && dependabot)
    add(
      "REMOTE-UPDATER-001",
      "high",
      "Dependency updaters overlap",
      "Both Renovate and Dependabot config are present.",
      "Keep one updater authoritative for overlapping ecosystems.",
    );
  else if (!renovate && !dependabot)
    add(
      "REMOTE-UPDATER-002",
      "medium",
      "No dependency updater detected",
      "Neither Renovate nor Dependabot config was found.",
      "Adopt the shared Renovate foundation when appropriate.",
      "coding-tooling bootstrap plan --json",
    );

  const workspaceConflict = workspaceToolchainConflict(components);
  if (workspaceConflict) {
    const owner = workspaceConflict.root?.identity;
    const members = workspaceConflict.members
      .map(
        (member) =>
          `${member.path} (${member.identity?.runtime ?? "unknown"}@${member.identity?.version ?? "unknown"})`,
      )
      .join(", ");
    add(
      "REMOTE-ENV-008",
      "high",
      "Workspace package toolchain identities conflict",
      `package.json establishes ${owner?.runtime ?? "unknown"}@${owner?.version ?? "unknown"} for the declared workspace; conflicting members: ${members}.`,
      "Keep one canonical workspace toolchain identity; remove redundant member pins or align explicit member identities with the workspace owner.",
    );
  }

  for (const component of components.filter((item) => item.kind === "package")) {
    const outcome = component.toolchain;
    if (outcome.reason === "workspace-toolchain-conflict") continue;
    if (outcome.status === "satisfied") continue;
    const suffix = component.path === "." ? "" : `-${stableId(component.path)}`;
    const nestedPrefix = component.path === "." ? "" : `${component.name}: `;
    if (outcome.status === "finding") {
      if (outcome.runtime === "bun")
        add(
          `REMOTE-ENV-005${suffix}`,
          "high",
          `${nestedPrefix}Bun toolchain pin is not exact`,
          `${component.evidence.facts.packageManager.provenance.path} does not contain an exact bun@x.y.z version.`,
          "Use an exact Bun packageManager version for deterministic environment identity.",
        );
      else
        add(
          `REMOTE-ENV-003${suffix}`,
          "high",
          `${nestedPrefix}Node toolchain pin is not exact`,
          `${component.evidence.facts.nodeVersion.provenance.path} does not contain an exact x.y.z version.`,
          "Use an exact Node version for deterministic environment identity.",
        );
      continue;
    }
    if (outcome.status === "unsupported") {
      add(
        `REMOTE-ENV-007${suffix}`,
        "medium",
        `${nestedPrefix}Package toolchain is unsupported by remote preflight`,
        `${component.evidence.facts.packageManager.provenance.path} declares ${component.evidence.facts.packageManager.value ?? "an unsupported package manager"}.`,
        "Treat package toolchain status as unsupported until a deterministic adapter is available.",
      );
      continue;
    }
    add(
      component.path === "." ? "REMOTE-ENV-001" : `REMOTE-ENV-006${suffix}`,
      "medium",
      `${nestedPrefix}${outcome.runtime === "bun" ? "Bun" : "Node"} toolchain pin is missing`,
      `${component.name} has no component-local exact ${outcome.runtime === "bun" ? "Bun" : "Node"} version evidence.`,
      component.path === "."
        ? `Use an exact x.y.z ${outcome.runtime === "bun" ? "Bun packageManager" : "Node .node-version"} pin when this runtime participates in validation.`
        : "Declare the nested component toolchain explicitly; remote preflight does not inherit unrelated root pins without a proven workspace relationship.",
    );
  }

  if (components.some((component) => component.kind === "rust")) {
    if (!paths.has("rust-toolchain.toml"))
      add(
        "REMOTE-ENV-002",
        "medium",
        "Rust toolchain declaration is missing",
        "A Rust component exists without rust-toolchain.toml.",
        "Declare an exact Rust toolchain and required components.",
      );
    else {
      const channel = snapshot.files["rust-toolchain.toml"]?.match(
        /^\s*channel\s*=\s*"([^"]+)"/m,
      )?.[1];
      if (!/^\d+\.\d+\.\d+$/.test(channel ?? ""))
        add(
          "REMOTE-ENV-004",
          "high",
          "Rust toolchain pin is not exact",
          "rust-toolchain.toml does not contain an exact x.y.z channel.",
          "Use an exact Rust channel for deterministic environment identity.",
        );
    }
  }
  for (const component of components) {
    const outcome = component.testEvidence;
    const suffix = component.path === "." ? "" : `-${stableId(component.path)}`;
    const nestedPrefix = component.path === "." ? "" : `${component.name}: `;
    if (outcome.status === "finding")
      add(
        `REMOTE-TEST-001${suffix}`,
        "high",
        `${nestedPrefix}No structural test files detected`,
        `${outcome.productionPathCount} component-owned production source file(s) were detected but no separate test-like files were found.`,
        "Use local deterministic findings before scaffolding tests.",
        "coding-tooling findings --json",
      );
    else if (outcome.reason === "rust-inline-tests-unobservable")
      add(
        `REMOTE-TEST-002${suffix}`,
        "low",
        `${nestedPrefix}Rust structural test evidence is incomplete`,
        `${outcome.productionPathCount} component-owned Rust production source file(s) were detected with no separate test-like paths. Inline #[cfg(test)] modules are not observable from the tree-only remote boundary.`,
        "Use local deterministic findings and test execution before deciding that Rust tests are missing.",
        "coding-tooling findings --json",
      );
  }

  const declaredRequiredCapabilities =
    config?.schemaVersion === 1
      ? Array.isArray(config.requiredCapabilities)
        ? config.requiredCapabilities.filter((capability) => typeof capability === "string")
        : []
      : null;
  if (declaredRequiredCapabilities !== null) {
    const available = new Set(
      components.flatMap((component) =>
        Object.entries(component.capabilities ?? {})
          .filter(([, command]) => validCommand(command))
          .map(([capability]) => capability),
      ),
    );
    const missing = declaredRequiredCapabilities
      .filter((capability) => !available.has(capability))
      .toSorted();
    if (missing.length)
      add(
        "REMOTE-CAPABILITY-REQUIRED",
        "medium",
        "Required validation capabilities are unavailable",
        `Missing repository-declared capabilities: ${missing.join(", ")}.`,
        "Provide the capability through a discovered component command or .coding-tooling.json capabilityCommands.",
        "coding-tooling conformance --json",
      );
  } else {
    for (const component of components.filter((item) => item.kind === "package")) {
      const outcomes = canonicalPackageCapabilityOutcomes(component.evidence);
      const incomplete = outcomes.filter((outcome) => outcome.status === "incomplete");
      if (incomplete.length) {
        add(
          `REMOTE-CAPABILITY-${stableId(component.path)}`,
          "medium",
          `${component.name} conventional script evidence is incomplete`,
          `Could not establish conventional package-script evidence for: ${incomplete.map((outcome) => outcome.capability).join(", ")}.`,
          "Run local deterministic analysis before treating these conventional scripts as present or absent.",
          "coding-tooling inspect --json",
        );
        continue;
      }
      const missing = outcomes
        .filter((outcome) => outcome.status === "finding")
        .map((outcome) => outcome.capability);
      if (missing.length)
        add(
          `REMOTE-CAPABILITY-${stableId(component.path)}`,
          "medium",
          `${component.name} lacks conventional package scripts`,
          `Conventional package scripts absent: ${missing.join(", ")}.`,
          "Treat this as package-shape guidance; repository-declared capabilities remain authoritative when configured.",
        );
    }
  }

  if (!paths.has("AGENTS.md"))
    add(
      "REMOTE-AGENT-001",
      "low",
      "No repository-specific AGENTS.md detected",
      "AGENTS.md is absent at repository root.",
      "Keep repository-specific guidance and exceptions in AGENTS.md.",
    );

  if (snapshot.treeTruncated)
    add(
      "REMOTE-SOURCE-001",
      "high",
      "GitHub tree was truncated",
      "GitHub reported truncated=true for the recursive tree.",
      "Treat this result as incomplete and run coding-tooling locally.",
    );
  if (snapshot.manifestFetchTruncated)
    add(
      "REMOTE-SOURCE-002",
      "high",
      "Manifest analysis hit the remote fetch budget",
      "At least one package.json was not fetched.",
      "Clone the repository for complete component discovery.",
    );
  if (snapshot.unreadablePaths.length)
    add(
      "REMOTE-SOURCE-003",
      "high",
      "Selected GitHub content could not be read",
      snapshot.unreadablePaths.join(", "),
      "Treat this result as incomplete and use local analysis.",
    );

  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  return findings.toSorted(
    (left, right) => rank[left.severity] - rank[right.severity] || left.id.localeCompare(right.id),
  );
}

function validationEvidenceFor(snapshot, paths, components) {
  const workflowPaths = [...paths]
    .filter((path) => /^\.github\/workflows\/.+\.ya?ml$/i.test(path))
    .toSorted();
  const externalCiPaths = [...paths].filter(isExternalCiPath).toSorted();
  const declaredCommands = components
    .flatMap((component) => Object.values(component.capabilities ?? {}))
    .filter(Array.isArray)
    .map((command) => command.join(" "));
  const workflows = workflowPaths
    .filter((path) => typeof snapshot.files[path] === "string")
    .map((path) => ({ path, content: snapshot.files[path] }));
  return remoteValidationOutcome({
    workflowPaths,
    workflows,
    externalCiPaths,
    workflowFetchTruncated: Boolean(snapshot.workflowFetchTruncated),
    defaultBranch: snapshot.repository.defaultBranch,
    declaredCommands,
    localActionIsCodingTooling: isCodingToolingAction(snapshot.files["action.yml"]),
  });
}

function isExternalCiPath(path) {
  return [
    ".circleci/config.yml",
    ".circleci/config.yaml",
    ".gitlab-ci.yml",
    ".gitlab-ci.yaml",
    ".travis.yml",
    "Jenkinsfile",
    "azure-pipelines.yml",
    "azure-pipelines.yaml",
    ".buildkite/pipeline.yml",
    ".buildkite/pipeline.yaml",
  ].includes(path);
}

function isCodingToolingAction(content) {
  if (typeof content !== "string") return false;
  return (
    /Run coding tooling/i.test(content) &&
    /src\/cli\.ts/.test(content) &&
    /\.coding-tooling\.json/.test(content)
  );
}

function componentOwnedPaths(paths, components, component, predicate) {
  return [...paths]
    .filter((path) => {
      if (
        isIgnoredAnalysisPath(path) ||
        !predicate(path) ||
        !componentSupportsSourceKind(component, path)
      )
        return false;
      return mostSpecificOwners(components, path).some(
        (owner) => componentIdentity(owner) === componentIdentity(component),
      );
    })
    .toSorted();
}

function mostSpecificOwners(components, path) {
  const matches = components.filter(
    (component) =>
      componentSupportsSourceKind(component, path) && componentContains(component, path),
  );
  if (matches.length === 0) return [];
  const maximumPathLength = Math.max(
    ...matches.map((component) => normalizedComponentPath(component).length),
  );
  return matches.filter(
    (component) => normalizedComponentPath(component).length === maximumPathLength,
  );
}

function componentSupportsSourceKind(component, path) {
  if (component.kind === "package") return /\.(?:[cm]?[jt]sx?)$/i.test(path);
  if (component.kind === "rust") return /\.rs$/i.test(path);
  if (component.kind === "dotnet") return /\.cs$/i.test(path);
  return false;
}

function componentContains(component, path) {
  const directory = normalizedComponentPath(component);
  return !directory || path === directory || path.startsWith(`${directory}/`);
}

function normalizedComponentPath(component) {
  return component.path === "." ? "" : component.path;
}

function componentIdentity(component) {
  return `${component.kind}:${component.path}:${component.name}`;
}

function priority(path) {
  if (path === ".coding-tooling.json") return 0;
  if (CONTEXT_FILES.has(path)) return 1;
  if (path === "package.json") return 2;
  if (basename(path) === ".node-version") return 20 + path.split("/").length;
  return 10 + path.split("/").length;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function isTestPath(path) {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__)\//.test(lower) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) ||
    /(test|tests)\.cs$/.test(lower)
  );
}

function isIgnoredAnalysisPath(path) {
  return path.split("/").some((segment) => IGNORED_ANALYSIS_SEGMENTS.has(segment));
}

function isProductionSource(path) {
  const lower = path.toLowerCase();
  if (isIgnoredAnalysisPath(path) || isTestPath(path)) return false;
  return !/\.stories\.[cm]?[jt]sx?$/.test(lower) && /\.(ts|tsx|js|jsx|mjs|cjs|rs|cs)$/.test(lower);
}

function stableId(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul((hash ^ character.charCodeAt(0)) >>> 0, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function basename(path) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function dirname(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function joinPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}
