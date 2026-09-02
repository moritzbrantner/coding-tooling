const SCRIPT_CAPABILITIES = {
  "format:check": ["format:check", "check:format"],
  lint: ["lint"],
  typecheck: ["typecheck", "check-types"],
  build: ["build"],
  "test:unit": ["test:unit", "test"],
  "test:integration": ["test:integration"],
  "test:e2e": ["test:e2e"],
  benchmark: ["benchmark", "bench"],
};

const CONTEXT_FILES = new Set([".coding-tooling.json", ".node-version", "rust-toolchain.toml"]);
const IGNORED_SOURCE_SEGMENTS = new Set([
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

export function selectedRemoteFiles(tree, limit = 24) {
  return tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        (basename(entry.path) === "package.json" || CONTEXT_FILES.has(entry.path)),
    )
    .sort(
      (left, right) =>
        priority(left.path) - priority(right.path) || left.path.localeCompare(right.path),
    )
    .slice(0, limit);
}

export function analyzeSnapshot(snapshot, now = new Date()) {
  const paths = new Set(
    snapshot.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
  );
  const components = discoverComponents(snapshot, paths);
  const technologies = [...new Set(components.flatMap((component) => component.technologies))].sort();
  const findings = findingsFor(snapshot, paths, components);
  const incomplete =
    snapshot.treeTruncated || snapshot.manifestFetchTruncated || snapshot.unreadablePaths.length > 0;
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
    findings,
    limitations: [
      "Remote preflight reads GitHub metadata, a recursive tree, and bounded text manifests; it does not clone or execute repository code.",
      "Findings are structural evidence, not claims about behavioral correctness, security, coverage, or runtime performance.",
      "Run coding-tooling locally for authoritative conformance, findings, environment verification, and validation execution.",
    ],
    agentHandoff: {
      purpose: "Continue from remote structural evidence to authoritative local deterministic analysis.",
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
    (candidate) => basename(candidate.path) === "package.json",
  )) {
    const manifest = parseJson(snapshot.files[entry.path]);
    if (!manifest) continue;
    const directory = dirname(entry.path);
    const path = directory || ".";
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const technologies = ["javascript"];
    if (paths.has(joinPath(directory, "tsconfig.json"))) technologies.push("typescript");
    for (const [dependency, technology] of [
      ["react", "react"],
      ["next", "nextjs"],
      ["vite", "vite"],
      ["vitest", "vitest"],
    ]) {
      if (dependency in dependencies) technologies.push(technology);
    }
    if (
      Object.keys(dependencies).some(
        (dependency) => dependency === "storybook" || dependency.startsWith("@storybook/"),
      )
    )
      technologies.push("storybook");

    const manager =
      paths.has(joinPath(directory, "bun.lock")) ||
      paths.has(joinPath(directory, "bun.lockb")) ||
      paths.has("bun.lock")
        ? "bun"
        : "npm";
    const capabilities = {};
    for (const [capability, candidates] of Object.entries(SCRIPT_CAPABILITIES)) {
      const script = candidates.find((candidate) => candidate in (manifest.scripts ?? {}));
      if (script)
        capabilities[capability] =
          manager === "bun" ? ["bun", "run", script] : ["npm", "run", script];
    }
    components.push({
      name: manifest.name ?? (path === "." ? snapshot.repository.name : basename(directory)),
      path,
      kind: "package",
      technologies,
      capabilities,
    });
  }

  for (const entry of snapshot.tree.filter(
    (candidate) => basename(candidate.path) === "Cargo.toml",
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

  for (const entry of snapshot.tree.filter((candidate) => /\.(sln|csproj)$/.test(candidate.path))) {
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
  return components.sort(
    (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
  );
}

function findingsFor(snapshot, paths, components) {
  const findings = [];
  const add = (id, severity, title, evidence, recommendation, command) =>
    findings.push({ id, severity, title, evidence, recommendation, ...(command ? { command } : {}) });
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

  if (![...paths].some((path) => path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path)))
    add(
      "REMOTE-CI-001",
      "high",
      "No GitHub Actions workflow detected",
      "No workflow YAML exists under .github/workflows/.",
      "Add deterministic CI around repository-declared validation capabilities.",
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

  if (components.some((component) => component.kind === "package")) {
    if (!paths.has(".node-version"))
      add(
        "REMOTE-ENV-001",
        "medium",
        "Node toolchain pin is missing",
        "A package component exists without .node-version.",
        "Use an exact x.y.z Node pin when Node participates in validation.",
      );
    else if (!/^\d+\.\d+\.\d+$/.test(snapshot.files[".node-version"]?.trim() ?? ""))
      add(
        "REMOTE-ENV-003",
        "high",
        "Node toolchain pin is not exact",
        ".node-version does not contain an exact x.y.z version.",
        "Use an exact Node version for deterministic environment identity.",
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
      const channel = snapshot.files["rust-toolchain.toml"]?.match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1];
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

  const production = [...paths].filter(isProductionSource);
  const tests = [...paths].filter(isTestPath);
  if (production.length && !tests.length)
    add(
      "REMOTE-TEST-001",
      "high",
      "No structural test files detected",
      `${production.length} production source file(s) were detected but no test-like files were found.`,
      "Use local deterministic findings before scaffolding tests.",
      "coding-tooling findings --json",
    );

  for (const component of components.filter((item) => item.kind === "package")) {
    const missing = ["format:check", "lint", "typecheck", "test:unit"].filter(
      (name) => !component.capabilities[name],
    );
    if (missing.length)
      add(
        `REMOTE-CAPABILITY-${stableId(component.path)}`,
        "medium",
        `${component.name} lacks canonical validation scripts`,
        `Missing: ${missing.join(", ")}.`,
        "Prefer repository-declared validation scripts over agent-invented commands.",
      );
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
  return findings.sort(
    (left, right) => rank[left.severity] - rank[right.severity] || left.id.localeCompare(right.id),
  );
}

function priority(path) {
  if (path === ".coding-tooling.json") return 0;
  if (CONTEXT_FILES.has(path)) return 1;
  if (path === "package.json") return 2;
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

function isProductionSource(path) {
  const lower = path.toLowerCase();
  if (
    path.split("/").some((segment) => IGNORED_SOURCE_SEGMENTS.has(segment)) ||
    isTestPath(path)
  )
    return false;
  return !/\.stories\.[cm]?[jt]sx?$/.test(lower) && /\.(ts|tsx|js|jsx|mjs|cjs|rs|cs)$/.test(lower);
}

function stableId(value) {
  let hash = 2166136261;
  for (const character of value)
    hash = Math.imul((hash ^ character.charCodeAt(0)) >>> 0, 16777619);
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
