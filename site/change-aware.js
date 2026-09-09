import { analyzeSnapshot, parseRepositoryReference, selectedRemoteFiles } from "./preflight.js";

const REMOTE_FILE_LIMIT = 32;
const COMPARE_FILE_LIMIT = 300;
const CANDIDATE_TEST_LIMIT = 8;

const capabilities = [
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:unit",
  "test:integration",
  "test:e2e",
  "test:e2e:smoke",
  "test:accessibility",
  "test:visual",
  "package:check",
  "dependencies:audit",
  "benchmark",
  "benchmark:smoke",
  "profile:runtime",
  "profile:hotspots",
  "profile:memory",
  "storybook:check",
  "web:audit",
  "template:smoke",
];

const defaultTiers = {
  fast: ["format:check", "lint", "typecheck", "test:unit", "build"],
  integration: ["test:integration"],
  e2e: ["test:e2e"],
  full: [
    "format:check",
    "lint",
    "typecheck",
    "test:unit",
    "test:integration",
    "test:e2e",
    "build",
  ],
};

const allComponentGlobalPaths = new Set([
  ".coding-tooling.json",
  "conventions.json",
  "conventions.lock.json",
]);

const packageGlobalPaths = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".oxlintrc.json",
  ".oxfmtrc.json",
]);

const rustGlobalPaths = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "deny.toml",
]);

export function isChangeAwareArgv(argv) {
  const args = normalizeArgv(argv);
  const command = args.find((value) => value !== "--json") ?? "";
  if (command === "affected") return true;
  if (command !== "plan") return false;
  return args.some((value) => ["--base", "--head", "--changed-file"].includes(value));
}

export async function remoteChangeCommand(value, argv, options = {}) {
  const started = Date.now();
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    return timed(
      envelope("affected", "error", { requestedArgv: inputArgv(argv) }, [
        {
          code: "invalid-repository",
          message: "Enter owner/repository or a github.com repository URL.",
        },
      ]),
      started,
    );

  let request;
  try {
    request = parseChangeCommand(argv);
  } catch (error) {
    return timed(
      envelope("affected", "error", { repository: `${reference.owner}/${reference.name}` }, [
        { code: "invalid-argv", message: error instanceof Error ? error.message : String(error) },
      ]),
      started,
    );
  }

  try {
    const loaded = await loadChangeSnapshot(reference, request, options);
    return timed(
      remoteChangeCommandFromSnapshot(
        loaded.snapshot,
        loaded.change,
        request,
        options.now ?? new Date(),
      ),
      started,
    );
  } catch (error) {
    return timed(
      envelope(request.operation, "error", { repository: `${reference.owner}/${reference.name}` }, [
        {
          code: "remote-change-analysis-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ]),
      started,
    );
  }
}

export function remoteChangeCommandFromSnapshot(snapshot, change, request, now = new Date()) {
  const analysis = analyzeSnapshot(snapshot, now);
  const config = readToolingConfig(snapshot);
  const selected = config.tiers?.[request.tier] ?? defaultTiers[request.tier];
  if (!selected)
    return invalidEnvelope(request.operation, snapshot, `Unknown tier: ${request.tier}`);

  try {
    validateCapabilities(selected);
    validateCapabilities(config.requiredCapabilities ?? []);
    validateCapabilities(config.optionalCapabilities ?? []);
  } catch (error) {
    return invalidEnvelope(
      request.operation,
      snapshot,
      error instanceof Error ? error.message : String(error),
    );
  }

  const scope = deriveAffectedScope(snapshot, analysis.components, change.files);
  const discoveredComponents = analysis.components.map((component) =>
    applyCapabilityCommands(componentView(component), config),
  );
  const selectedComponents = selectComponents(discoveredComponents, scope, request.component);
  if (request.component && selectedComponents.length === 0)
    return invalidEnvelope(
      request.operation,
      snapshot,
      `Unknown or unaffected component: ${request.component}`,
    );

  const checks = buildChecks(selectedComponents, selected);
  const missing = missingCapabilities(checks, selected, config, selectedComponents);
  const affectedComponents = selectedComponents.map((component) => {
    const changedPaths = scope.changedByComponent.get(componentIdentity(component)) ?? [];
    return {
      name: component.name,
      path: component.path,
      kind: component.kind,
      technologies: component.technologies,
      changedPaths,
      governingContracts: governingContracts(snapshot, component, changedPaths),
      candidateTests: candidateTests(snapshot, component, changedPaths, discoveredComponents),
      selectedCapabilities: [...new Set(selected)].filter(
        (capability) => component.capabilities[capability],
      ),
    };
  });

  const sourceIncomplete =
    analysis.summary.status === "incomplete" ||
    change.filesTruncated ||
    Boolean(change.compareIncomplete);
  const blockingMissing = missing.some((item) => !item.optional);
  const diagnostics = [
    ...missing.map((item) => ({
      code: item.optional ? "optional-capability-unavailable" : "capability-unavailable",
      message: `${item.capability} is unavailable for ${item.component}`,
    })),
  ];
  if (sourceIncomplete)
    diagnostics.push({
      code: "remote-change-source-incomplete",
      message:
        "The GitHub change or repository snapshot is incomplete; the plan was widened conservatively where possible.",
    });
  if (scope.mode === "conservative-all")
    diagnostics.push({
      code: "remote-change-scope-widened",
      message:
        "At least one changed path has cross-component or unresolved impact, so validation was widened to all discovered components.",
    });
  if (scope.mode === "documentation-only")
    diagnostics.push({
      code: "remote-change-documentation-only",
      message:
        "Only documentation-like paths changed; no component validation commands were selected remotely.",
    });
  if (scope.mode === "no-changes")
    diagnostics.push({
      code: "remote-change-empty",
      message: "The supplied compare range contains no changed paths.",
    });
  if ((config.conventionRefs ?? []).length > 0)
    diagnostics.push({
      code: "remote-convention-execution-not-evaluated",
      message:
        "Installed convention execution remains local-only; the change-aware plan routes repository-declared capabilities only.",
    });

  const common = {
    root: remoteRoot(snapshot, change.head),
    repository: snapshot.repository,
    source: { ...analysis.source, ref: change.head },
    change: {
      base: change.base ?? null,
      head: change.head,
      origin: change.origin,
      compareStatus: change.compareStatus ?? null,
      aheadBy: change.aheadBy ?? null,
      behindBy: change.behindBy ?? null,
      totalCommits: change.totalCommits ?? null,
      filesTruncated: Boolean(change.filesTruncated),
      files: change.files,
    },
    scope: {
      mode: scope.mode,
      reasons: scope.reasons,
      unresolvedChangedPaths: scope.unresolvedChangedPaths,
      documentationPaths: scope.documentationPaths,
      affectedComponents,
    },
  };

  if (request.operation === "affected")
    return envelope(
      "affected",
      sourceIncomplete || blockingMissing ? "unavailable" : "passed",
      {
        ...common,
        validationPlan: {
          tier: request.tier,
          complete: !sourceIncomplete && !blockingMissing,
          checks,
          missing,
          remoteScope: "change-aware-structural-plan-only",
        },
      },
      diagnostics,
    );

  let planStatus = "unavailable";
  if (
    !sourceIncomplete &&
    !blockingMissing &&
    (checks.length > 0 || ["documentation-only", "no-changes"].includes(scope.mode))
  )
    planStatus = "passed";

  return envelope(
    "plan",
    planStatus,
    {
      ...common,
      profile: config.profile,
      tier: request.tier,
      dependencyResolution: "distribution",
      complete: !sourceIncomplete && !blockingMissing,
      checks,
      missing,
      conventionRequiredCapabilities: [],
      conventionRefs: config.conventionRefs ?? [],
      remoteScope: "change-aware-structural-plan-only",
    },
    diagnostics,
  );
}

function parseChangeCommand(argv) {
  const args = normalizeArgv(argv);
  const command = args[0];
  if (!new Set(["affected", "plan"]).has(command))
    throw new Error("Change-aware Pages supports affected or plan commands only.");

  let base;
  let head;
  let tier = "fast";
  let component;
  const changedFiles = [];
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json") continue;
    if (["--base", "--head", "--tier", "--component", "--changed-file"].includes(value)) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      if (value === "--base") base = next;
      else if (value === "--head") head = next;
      else if (value === "--tier") tier = next;
      else if (value === "--component") component = next;
      else changedFiles.push(next);
      index += 1;
      continue;
    }
    throw new Error(`Unsupported change-aware Pages argument: ${value}`);
  }

  if (command === "plan" && !args.includes("--tier"))
    throw new Error("plan requires --tier <name>.");
  if (!base && changedFiles.length === 0)
    throw new Error(
      "affected/change-aware plan requires --base <ref> or at least one --changed-file <path>.",
    );

  return {
    operation: command,
    base,
    head,
    tier,
    component,
    changedFiles: [...new Set(changedFiles.map(normalizePath).filter(Boolean))],
  };
}

async function loadChangeSnapshot(reference, request, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
  const repository = await githubJson(
    `/repos/${reference.owner}/${reference.name}`,
    fetchImpl,
    signal,
  );
  const head = request.head ?? repository.default_branch;
  let compare;
  let files;

  if (request.changedFiles.length > 0) {
    files = request.changedFiles.map((path) => ({ path, status: "provided" }));
  } else {
    compare = await githubJson(
      `/repos/${reference.owner}/${reference.name}/compare/${encodeURIComponent(
        request.base,
      )}...${encodeURIComponent(head)}`,
      fetchImpl,
      signal,
    );
    files = (compare.files ?? [])
      .filter((file) => file.filename)
      .map((file) => ({
        path: normalizePath(file.filename),
        status: file.status ?? "modified",
        ...(file.previous_filename
          ? { previousPath: normalizePath(file.previous_filename) }
          : {}),
      }));
  }

  const tree = await githubJson(
    `/repos/${reference.owner}/${reference.name}/git/trees/${encodeURIComponent(head)}?recursive=1`,
    fetchImpl,
    signal,
  );
  const entries = (tree.tree ?? []).filter(
    (entry) => entry.path && entry.sha && ["blob", "tree"].includes(entry.type),
  );
  const eligible = selectedRemoteFiles(entries, entries.length);
  const selected = selectChangeRemoteFiles(entries, files.map((file) => file.path));
  const selectedPackages = selected.filter((entry) => entry.path.endsWith("package.json")).length;
  const packageCount = eligible.filter((entry) => entry.path.endsWith("package.json")).length;
  const fileContents = {};
  const unreadablePaths = [];

  await Promise.all(
    selected.map(async (entry) => {
      try {
        const blob = await githubJson(
          `/repos/${reference.owner}/${reference.name}/git/blobs/${entry.sha}`,
          fetchImpl,
          signal,
        );
        if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
        fileContents[entry.path] = decodeBase64(blob.content);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        unreadablePaths.push(entry.path);
      }
    }),
  );

  return {
    snapshot: {
      repository: {
        owner: repository.owner.login,
        name: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        htmlUrl: repository.html_url,
        description: repository.description,
        archived: repository.archived,
        fork: repository.fork,
        stars: repository.stargazers_count,
        openIssues: repository.open_issues_count,
      },
      tree: entries,
      files: fileContents,
      treeTruncated: Boolean(tree.truncated),
      manifestFetchTruncated: selectedPackages < packageCount,
      unreadablePaths: unreadablePaths.toSorted(),
    },
    change: {
      base: request.base,
      head,
      origin: request.changedFiles.length > 0 ? "provided-paths" : "github-compare",
      compareStatus: compare?.status,
      aheadBy: compare?.ahead_by,
      behindBy: compare?.behind_by,
      totalCommits: compare?.total_commits,
      compareIncomplete: !request.changedFiles.length && !Array.isArray(compare?.files),
      filesTruncated: !request.changedFiles.length && files.length >= COMPARE_FILE_LIMIT,
      files,
    },
  };
}

function selectChangeRemoteFiles(entries, changedPaths) {
  const eligible = selectedRemoteFiles(entries, entries.length);
  const changed = new Set(changedPaths);
  const scored = eligible.map((entry) => ({
    entry,
    score: remoteFileScore(entry.path, changed),
  }));
  return scored
    .toSorted(
      (left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path),
    )
    .slice(0, REMOTE_FILE_LIMIT)
    .map(({ entry }) => entry);
}

function remoteFileScore(path, changedPaths) {
  if (path === ".coding-tooling.json" || path === "rust-toolchain.toml") return 100;
  if (changedPaths.has(path)) return 95;
  const directory = dirname(path);
  if (
    path.endsWith("package.json") &&
    [...changedPaths].some((changed) => isInside(directory, changed))
  )
    return 90;
  if (
    path.endsWith(".node-version") &&
    [...changedPaths].some((changed) => isInside(directory, changed))
  )
    return 85;
  if (path === "package.json") return 80;
  return 10;
}

function deriveAffectedScope(snapshot, components, changedFiles) {
  const changedByComponent = new Map();
  if (changedFiles.length === 0)
    return {
      mode: "no-changes",
      reasons: ["no-changed-paths"],
      unresolvedChangedPaths: [],
      documentationPaths: [],
      changedByComponent,
    };
  const unresolvedChangedPaths = [];
  const documentationPaths = [];
  const reasons = [];
  const allComponents = components.map(componentView);
  let widenAll =
    snapshot.treeTruncated ||
    snapshot.manifestFetchTruncated ||
    snapshot.unreadablePaths.length > 0;
  if (widenAll) reasons.push("repository-snapshot-incomplete");

  for (const file of changedFiles) {
    const paths = [file.path, file.previousPath].filter(Boolean);
    for (const path of paths) {
      if (isDocumentationPath(path)) {
        documentationPaths.push(path);
        continue;
      }

      const globalKinds = globalImpactKinds(path);
      if (globalKinds === "all") {
        widenAll = true;
        reasons.push(`global-contract:${path}`);
        continue;
      }
      if (Array.isArray(globalKinds)) {
        const matches = allComponents.filter((component) => globalKinds.includes(component.kind));
        if (matches.length === 0) {
          unresolvedChangedPaths.push(path);
          widenAll = true;
          reasons.push(`unresolved-global:${path}`);
        } else {
          for (const component of matches) addChanged(changedByComponent, component, path);
        }
        continue;
      }

      const owner = mostSpecificOwner(allComponents, path);
      if (owner) addChanged(changedByComponent, owner, path);
      else {
        unresolvedChangedPaths.push(path);
        widenAll = true;
        reasons.push(`unresolved-path:${path}`);
      }
    }
  }

  if (widenAll) {
    for (const component of allComponents) {
      const existing = changedByComponent.get(componentIdentity(component)) ?? [];
      changedByComponent.set(componentIdentity(component), existing);
    }
    return {
      mode: "conservative-all",
      reasons: [...new Set(reasons)],
      unresolvedChangedPaths: [...new Set(unresolvedChangedPaths)].toSorted(),
      documentationPaths: [...new Set(documentationPaths)].toSorted(),
      changedByComponent,
    };
  }

  if (changedByComponent.size === 0 && documentationPaths.length > 0)
    return {
      mode: "documentation-only",
      reasons: ["documentation-only-change"],
      unresolvedChangedPaths: [],
      documentationPaths: [...new Set(documentationPaths)].toSorted(),
      changedByComponent,
    };

  return {
    mode: "targeted",
    reasons: ["component-path-ownership"],
    unresolvedChangedPaths: [...new Set(unresolvedChangedPaths)].toSorted(),
    documentationPaths: [...new Set(documentationPaths)].toSorted(),
    changedByComponent,
  };
}

function selectComponents(components, scope, requestedComponent) {
  if (["documentation-only", "no-changes"].includes(scope.mode)) return [];
  let selected =
    scope.mode === "conservative-all"
      ? components
      : components.filter((component) =>
          scope.changedByComponent.has(componentIdentity(component)),
        );
  if (requestedComponent)
    selected = selected.filter(
      (component) => component.name === requestedComponent || component.path === requestedComponent,
    );
  return selected;
}

function buildChecks(components, selectedCapabilities) {
  const checks = [];
  for (const component of components) {
    for (const capability of new Set(selectedCapabilities)) {
      const command = component.capabilities[capability];
      if (!command) continue;
      checks.push({
        capability,
        component: component.name,
        path: component.path,
        command,
        reason: "affected-component",
      });
    }
  }
  return checks;
}

function missingCapabilities(checks, selected, config, components) {
  if (components.length === 0) return [];
  const required = new Set(config.requiredCapabilities ?? []);
  const optional = new Set(config.optionalCapabilities ?? []);
  const present = new Set(
    checks.map((check) => `${check.path}:${check.component}:${check.capability}`),
  );
  const missing = [];
  for (const component of components) {
    for (const capability of new Set(selected)) {
      if (present.has(`${component.path}:${component.name}:${capability}`)) continue;
      if (required.has(capability))
        missing.push({ capability, component: component.name, optional: false });
      else if (optional.has(capability))
        missing.push({ capability, component: component.name, optional: true });
    }
  }
  return missing;
}

function governingContracts(snapshot, component, changedPaths) {
  const paths = new Set(
    snapshot.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
  );
  const contracts = [];
  if (paths.has(".coding-tooling.json")) contracts.push(".coding-tooling.json");
  const manifest = componentManifest(component);
  if (manifest && paths.has(manifest)) contracts.push(manifest);
  const agent = nearestAncestorFile(paths, component.path, "AGENTS.md");
  if (agent) contracts.push(agent);
  for (const changed of changedPaths) {
    if (isContractLikePath(changed) && paths.has(changed)) contracts.push(changed);
  }
  return [...new Set(contracts)];
}

function candidateTests(snapshot, component, changedPaths, components) {
  const tests = snapshot.tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        isTestPath(entry.path) &&
        componentIdentity(mostSpecificOwner(components, entry.path) ?? component) ===
          componentIdentity(component),
    )
    .map((entry) => entry.path);
  const changedStems = new Set(changedPaths.map(stem).filter(Boolean));
  const changed = new Set(changedPaths);
  return tests
    .map((path) => ({
      path,
      score:
        (changed.has(path) ? 100 : 0) +
        (changedStems.has(stem(path)) ? 50 : 0) +
        (changedPaths.some((candidate) => dirname(candidate) === dirname(path)) ? 10 : 0),
    }))
    .toSorted((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, CANDIDATE_TEST_LIMIT)
    .map(({ path }) => path);
}

function readToolingConfig(snapshot) {
  const raw = snapshot.files[".coding-tooling.json"];
  if (!raw) return { schemaVersion: 1 };
  const config = JSON.parse(raw);
  if (config?.schemaVersion !== 1) throw new Error(".coding-tooling.json must use schemaVersion 1");
  for (const values of Object.values(config.tiers ?? {})) validateCapabilities(values);
  validateCapabilities(config.requiredCapabilities ?? []);
  validateCapabilities(config.optionalCapabilities ?? []);
  const required = new Set(config.requiredCapabilities ?? []);
  for (const capability of config.optionalCapabilities ?? []) {
    if (required.has(capability))
      throw new Error(`${capability} cannot be both required and optional`);
  }
  for (const [selector, commands] of Object.entries(config.capabilityCommands ?? {})) {
    if (!selector.trim()) throw new Error("capabilityCommands selectors must not be empty");
    if (!commands || typeof commands !== "object" || Array.isArray(commands))
      throw new Error(`capabilityCommands.${selector} must be a capability map`);
    for (const [capability, command] of Object.entries(commands)) {
      validateCapabilities([capability]);
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        command.some((part) => typeof part !== "string" || !part)
      )
        throw new Error(
          `capabilityCommands.${selector}.${capability} must be a non-empty argv array`,
        );
    }
  }
  return config;
}

function applyCapabilityCommands(component, config) {
  return {
    ...component,
    capabilities: {
      ...component.capabilities,
      ...config.capabilityCommands?.[component.name],
      ...config.capabilityCommands?.[component.path],
    },
  };
}

function validateCapabilities(values) {
  if (!Array.isArray(values)) throw new Error("Capability lists must be arrays.");
  for (const value of values) {
    if (!capabilities.includes(value)) throw new Error(`Unknown capability: ${value}`);
  }
}

function globalImpactKinds(path) {
  if (
    allComponentGlobalPaths.has(path) ||
    path.startsWith(".github/workflows/") ||
    path.startsWith(".conventions/")
  )
    return "all";
  if (packageGlobalPaths.has(path)) return ["package"];
  if (rustGlobalPaths.has(path)) return ["rust"];
  if (
    /^(Directory\.Build\.|Directory\.Packages\.|global\.json$)/.test(path) ||
    /\.(sln|slnx)$/.test(path)
  )
    return ["dotnet"];
  return null;
}

function mostSpecificOwner(components, path) {
  return components
    .filter((component) => componentContains(component, path))
    .toSorted(
      (left, right) => normalizedComponentPath(right).length - normalizedComponentPath(left).length,
    )[0];
}

function componentContains(component, path) {
  return isInside(normalizedComponentPath(component), path);
}

function normalizedComponentPath(component) {
  return component.path === "." ? "" : normalizePath(component.path);
}

function isInside(directory, path) {
  if (!directory) return true;
  return path === directory || path.startsWith(`${directory}/`);
}

function addChanged(map, component, path) {
  const id = componentIdentity(component);
  const existing = map.get(id) ?? [];
  if (!existing.includes(path)) map.set(id, [...existing, path].toSorted());
}

function componentIdentity(component) {
  return `${component.kind}:${component.path}:${component.name}`;
}

function componentManifest(component) {
  const base = component.path === "." ? "" : `${component.path}/`;
  if (component.kind === "package") return `${base}package.json`;
  if (component.kind === "rust") return `${base}Cargo.toml`;
  return null;
}

function nearestAncestorFile(paths, componentPath, filename) {
  let directory = componentPath === "." ? "" : componentPath;
  while (true) {
    const candidate = directory ? `${directory}/${filename}` : filename;
    if (paths.has(candidate)) return candidate;
    if (!directory) return null;
    directory = dirname(directory);
  }
}

function isDocumentationPath(path) {
  const lower = path.toLowerCase();
  return [".md", ".mdx", ".rst", ".adoc", ".txt"].some((extension) =>
    lower.endsWith(extension),
  );
}

function isContractLikePath(path) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith("agents.md") ||
    lower.includes("contract") ||
    lower.includes("invariant") ||
    lower.includes("schema") ||
    lower.startsWith("docs/adr/")
  );
}

function isTestPath(path) {
  return (
    /(^|\/)(tests?|__tests__|e2e|specs?)(\/|$)/i.test(path) ||
    /\.(test|spec)\.[A-Za-z0-9]+$/i.test(path)
  );
}

function stem(path) {
  const name = path.split("/").at(-1) ?? "";
  return name.replace(/\.(test|spec)/i, "").replace(/\.[^.]+$/, "").toLowerCase();
}

function componentView(component) {
  return {
    name: component.name,
    path: component.path,
    kind: component.kind,
    technologies: component.technologies,
    capabilities: component.capabilities,
  };
}

async function githubJson(path, fetchImpl, signal) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.ok) return response.json();
  if (response.status === 404)
    throw new Error("Repository, ref, or compare range was not found on GitHub.");
  if (response.status === 403)
    throw new Error(
      "GitHub rejected the anonymous request, usually because the public API rate limit was reached.",
    );
  throw new Error(`GitHub API request failed (${response.status}).`);
}

function decodeBase64(value) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/\n/g, "")), (character) => character.charCodeAt(0)),
  );
}

function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function remoteRoot(snapshot, head) {
  return `github:${snapshot.repository.fullName}@${head}`;
}

function envelope(operation, status, data, diagnostics = []) {
  return { schemaVersion: 1, operation, status, durationMs: 0, data, diagnostics };
}

function invalidEnvelope(operation, snapshot, message) {
  return envelope(
    operation,
    "error",
    { root: remoteRoot(snapshot, snapshot.repository.defaultBranch) },
    [{ code: "invalid-remote-change-command", message }],
  );
}

function timed(result, started) {
  return { ...result, durationMs: Date.now() - started };
}

function normalizeArgv(value) {
  const args = Array.isArray(value) ? [...value] : tokenize(value ?? "");
  if (args[0] === "coding-tooling") args.shift();
  return args;
}

function tokenize(input) {
  if (typeof input !== "string")
    throw new Error("argv must be a string or an array of arguments.");
  const args = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let active = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      active = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      active = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (active) {
        args.push(token);
        token = "";
        active = false;
      }
      continue;
    }
    token += character;
    active = true;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unterminated quote in argv.");
  if (active) args.push(token);
  return args;
}

function inputArgv(value) {
  return Array.isArray(value) ? value : typeof value === "string" ? value : [];
}
