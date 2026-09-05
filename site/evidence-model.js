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
