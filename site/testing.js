import { loadSnapshot } from "./github-analysis.js";
import { analyzeSnapshot, parseRepositoryReference } from "./preflight.js";

const ignoredTreeSegments = new Set([
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

const nonProductionSegments = new Set([
  ...ignoredTreeSegments,
  ".storybook",
  "__tests__",
  "test",
  "tests",
  "stories",
]);

export async function testingJson(value, options = {}) {
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    throw new Error("Enter owner/repository or a github.com repository URL.");

  const snapshot = await loadSnapshot(reference, options);
  return testingPlan(snapshot, options.now ?? new Date());
}

export function testingPlan(snapshot, now = new Date()) {
  const analysis = analyzeSnapshot(snapshot, now);
  const paths = snapshot.tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path &&
        !hasIgnoredSegment(entry.path, ignoredTreeSegments),
    )
    .map((entry) => entry.path)
    .toSorted();
  const sourcePaths = paths.filter(isTypeScriptProductionSource);
  const packageComponents = analysis.components
    .filter((component) => component.kind === "package")
    .toSorted(
      (left, right) => right.path.length - left.path.length || left.path.localeCompare(right.path),
    );
  const actions = [];
  const components = [];

  for (const component of packageComponents) {
    const componentSources = sourcePaths.filter((path) =>
      belongsToComponent(path, component.path, packageComponents),
    );
    if (componentSources.length === 0) continue;

    const componentPaths = paths.filter((path) => isWithin(path, component.path));
    const reactSources = component.technologies.includes("react")
      ? componentSources.filter((path) => isReactComponentCandidate(path, component.path))
      : [];
    const unitSetupId = component.capabilities["test:unit"]
      ? null
      : `TESTING-SETUP-${stableId(`${component.path}:unit`)}`;
    const storybookSetupId =
      reactSources.length > 0 && !component.technologies.includes("storybook")
        ? `TESTING-SETUP-${stableId(`${component.path}:storybook`)}`
        : null;

    if (unitSetupId) {
      actions.push({
        id: unitSetupId,
        kind: "test-runner-setup",
        priority: "high",
        confidence: "high",
        component: componentRef(component),
        evidence: `${componentSources.length} TypeScript production source file(s) exist but the package exposes no test:unit capability.`,
        recommendation:
          "Add a repository-native unit-test runner and canonical test:unit script before adding file-level tests; preserve the repository package manager and version policy.",
        changes: [
          {
            path: packageJsonPath(component.path),
            operation: "update",
            purpose: "Declare the unit-test dependency and canonical test:unit script.",
          },
        ],
      });
    }

    if (storybookSetupId) {
      actions.push({
        id: storybookSetupId,
        kind: "storybook-setup",
        priority: "medium",
        confidence: "high",
        component: componentRef(component),
        evidence: `${reactSources.length} React component candidate(s) exist but Storybook was not detected in package dependencies.`,
        recommendation:
          "Add the framework-appropriate Storybook integration and keep its configuration local to this package.",
        changes: [
          {
            path: packageJsonPath(component.path),
            operation: "update",
            purpose:
              "Declare Storybook using repository dependency/version policy and expose a storybook script.",
          },
          {
            path: joinPath(component.path, ".storybook/main.ts"),
            operation: "create-or-update",
            purpose: "Configure stories for the package without changing application behavior.",
          },
        ],
      });
    }

    for (const sourcePath of componentSources) {
      if (!hasMatchingTest(sourcePath, component.path, componentPaths)) {
        const targetPath = plannedTestPath(sourcePath, component.path);
        actions.push({
          id: `TESTING-UNIT-${stableId(sourcePath)}`,
          kind: "unit-test",
          priority: "medium",
          confidence: "high",
          component: componentRef(component),
          sourcePath,
          targetPath,
          evidence: "No structurally matching test or spec file was found for this source path.",
          recommendation:
            "Read the source, then add the smallest deterministic test of externally observable behavior using the package's existing test conventions.",
          requires: unitSetupId ? [unitSetupId] : [],
          applyPolicy: [
            "Do not create a todo-only or assertion-free test.",
            "Do not test private implementation details merely to satisfy the scaffold.",
            "If the file is a type-only module, barrel, generated adapter, or otherwise has no useful runtime behavior, skip it and record the reason instead of inventing a test.",
          ],
          verification: component.capabilities["test:unit"] ?? null,
        });
      }

      if (
        reactSources.includes(sourcePath) &&
        !hasMatchingStory(sourcePath, component.path, componentPaths)
      ) {
        actions.push({
          id: `TESTING-STORY-${stableId(sourcePath)}`,
          kind: "storybook-story",
          priority: "low",
          confidence: "medium",
          component: componentRef(component),
          sourcePath,
          targetPath: plannedStoryPath(sourcePath),
          evidence:
            "The TSX filename/path looks like a React component and no structurally matching Storybook story was found.",
          recommendation:
            "Read the component and add a representative story for a stable default or canonical state; skip with a reason if the file is not actually a reusable component.",
          requires: storybookSetupId ? [storybookSetupId] : [],
          applyPolicy: [
            "Do not invent domain data that changes the component contract.",
            "Prefer deterministic local args/fixtures over network-backed stories.",
            "Treat this as a component-shape heuristic, not proof that every TSX file requires Storybook.",
          ],
        });
      }
    }

    components.push({
      ...componentRef(component),
      sourceCount: componentSources.length,
      reactComponentCandidateCount: reactSources.length,
      hasUnitTestCapability: Boolean(component.capabilities["test:unit"]),
      hasStorybook: component.technologies.includes("storybook"),
    });
  }

  const sortedActions = actions.toSorted(
    (left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
  const incomplete =
    snapshot.treeTruncated ||
    snapshot.manifestFetchTruncated ||
    snapshot.unreadablePaths.length > 0;

  return {
    schemaVersion: 1,
    operation: "remote-testing-scaffold-plan",
    generatedAt: now.toISOString(),
    source: {
      provider: "github",
      repository: snapshot.repository.fullName,
      defaultBranch: snapshot.repository.defaultBranch,
      treeTruncated: snapshot.treeTruncated,
      manifestFetchTruncated: snapshot.manifestFetchTruncated,
      unreadablePaths: snapshot.unreadablePaths,
    },
    repository: snapshot.repository,
    summary: {
      status: incomplete
        ? "incomplete"
        : sortedActions.length > 0
          ? "changes-recommended"
          : "ready",
      componentCount: components.length,
      typeScriptSourceCount: sourcePaths.length,
      actionCount: sortedActions.length,
      unitTestActionCount: sortedActions.filter((action) => action.kind === "unit-test").length,
      storyActionCount: sortedActions.filter((action) => action.kind === "storybook-story").length,
      setupActionCount: sortedActions.filter((action) => action.kind.endsWith("-setup")).length,
    },
    components: components.toSorted((left, right) => left.path.localeCompare(right.path)),
    actions: sortedActions,
    pullRequest: {
      suggestedTitle: "test: add baseline testing scaffolding",
      applyOrder: sortedActions.map((action) => action.id),
      instructions: [
        "Apply setup actions before dependent file-level actions.",
        "Fetch and read every sourcePath before writing its targetPath; this plan does not synthesize behavioral assertions from filenames alone.",
        "Keep each generated test or story small, deterministic, and aligned with existing repository conventions.",
        "Run repository-declared formatting, linting, typechecking, tests, and Storybook checks when available before merge.",
      ],
    },
    limitations: [
      "This browser-only plan reads GitHub metadata, a recursive tree, and bounded manifests; it does not execute repository code or tests.",
      "File-level unit-test recommendations are structural reachability hints. Type-only modules and barrels may be legitimate skip cases after source inspection.",
      "React component detection is a conservative filename/path heuristic for TSX files, so Storybook actions have medium confidence until the source is read.",
      "The local coding-tooling findings and repository CI remain authoritative for deterministic validation and behavioral correctness.",
    ],
  };
}

function belongsToComponent(path, componentPath, components) {
  if (!isWithin(path, componentPath)) return false;
  return !components.some(
    (candidate) =>
      candidate.path !== componentPath &&
      candidate.path.length > componentPath.length &&
      isWithin(path, candidate.path),
  );
}

function isWithin(path, componentPath) {
  return componentPath === "." || path === componentPath || path.startsWith(`${componentPath}/`);
}

function componentRef(component) {
  return {
    name: component.name,
    path: component.path,
    technologies: component.technologies,
  };
}

function packageJsonPath(componentPath) {
  return joinPath(componentPath, "package.json");
}

function isTypeScriptProductionSource(path) {
  if (!/\.(?:ts|tsx|mts|cts)$/.test(path) || /\.d\.ts$/.test(path)) return false;
  const name = basename(path);
  if (/\.(?:test|spec|stories?)\.(?:ts|tsx|mts|cts)$/.test(name)) return false;
  if (/^(?:vite|vitest|next|eslint|storybook|playwright)\.config\./.test(name)) return false;
  if (/\.config\.(?:ts|mts|cts)$/.test(name)) return false;
  return !hasIgnoredSegment(path, nonProductionSegments);
}

function isReactComponentCandidate(path, componentPath) {
  if (!path.endsWith(".tsx")) return false;
  const local = relativeToComponent(path, componentPath);
  const segments = local.split("/");
  const file = segments.at(-1) ?? "";
  const stem = file.slice(0, -4);
  return (
    segments.some((segment) => ["components", "component", "ui"].includes(segment.toLowerCase())) ||
    /^[A-Z][A-Za-z0-9_$]*$/.test(stem)
  );
}

function hasMatchingTest(sourcePath, componentPath, componentPaths) {
  const identity = sourceIdentity(sourcePath, componentPath);
  return componentPaths.some((path) => {
    const test = testIdentity(path, componentPath);
    return test === identity || test?.startsWith(`${identity}-`) === true;
  });
}

function hasMatchingStory(sourcePath, componentPath, componentPaths) {
  const identity = sourceIdentity(sourcePath, componentPath);
  return componentPaths.some((path) => storyIdentity(path, componentPath) === identity);
}

function sourceIdentity(path, componentPath) {
  const local = stripSourceRoot(relativeToComponent(path, componentPath));
  return local.replace(/\.(?:ts|tsx|mts|cts)$/, "");
}

function testIdentity(path, componentPath) {
  const local = relativeToComponent(path, componentPath);
  const withoutRoot = local.startsWith("tests/")
    ? local.slice(6)
    : local.startsWith("src/")
      ? local.slice(4)
      : local;
  return withoutRoot.match(/^(.*)\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/)?.[1];
}

function storyIdentity(path, componentPath) {
  const local = relativeToComponent(path, componentPath);
  const withoutRoot = local.startsWith("stories/")
    ? local.slice(8)
    : local.startsWith("src/")
      ? local.slice(4)
      : local;
  return withoutRoot.match(/^(.*)\.stories?\.(?:[cm]?[jt]sx?)$/)?.[1];
}

function plannedTestPath(sourcePath, componentPath) {
  const local = stripSourceRoot(relativeToComponent(sourcePath, componentPath));
  const extension = local.match(/\.(tsx|ts|mts|cts)$/)?.[1] ?? "ts";
  const stem = local.replace(/\.(?:ts|tsx|mts|cts)$/, "");
  return joinPath(componentPath, `tests/${stem}.test.${extension}`);
}

function plannedStoryPath(sourcePath) {
  return sourcePath.replace(/\.tsx$/, ".stories.tsx");
}

function relativeToComponent(path, componentPath) {
  return componentPath === "." ? path : path.slice(componentPath.length + 1);
}

function stripSourceRoot(path) {
  return path.startsWith("src/") ? path.slice(4) : path;
}

function hasIgnoredSegment(path, segments) {
  return path.split("/").some((segment) => segments.has(segment));
}

function priorityRank(priority) {
  return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}

function stableId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function joinPath(left, right) {
  return left === "." || !left ? right : `${left}/${right}`;
}

function basename(path) {
  return path.split("/").at(-1) ?? path;
}
