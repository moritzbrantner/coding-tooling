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
  const lockfiles = [...new Set((input.lockfiles ?? []).filter((item) => typeof item === "string"))]
    .toSorted();
  const packageManager = typeof input.packageManager === "string" ? input.packageManager : null;

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
      tsconfig: {
        status: "available",
        value: Boolean(input.hasTsconfig),
        provenance: provenance(collector, input.tsconfigPath ?? `${path === "." ? "" : `${path}/`}tsconfig.json`),
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

export function canonicalPackageCapabilityOutcomes(
  evidence,
  required = ["format:check", "lint", "typecheck", "test:unit"],
) {
  if (evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported normalized package evidence schema");
  }
  if (evidence.facts.manifest.status !== "available" || evidence.facts.scripts.status !== "available") {
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
