import { NORMALIZED_EVIDENCE_SCHEMA_VERSION } from "./evidence-model.js";

const declarations = { rust: ["rust-toolchain", "rust-toolchain.toml"], dotnet: ["global.json"] };
const exactVersion = /^\d+\.\d+\.\d+$/;

export function projectToolchainPaths(path, kind) {
  if (!Object.hasOwn(declarations, kind)) throw new Error(`Unsupported project kind: ${kind}`);
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || !part)
  )
    throw new Error("Project path must stay repository-relative");
  const paths = [];
  let directory = path;
  while (true) {
    paths.push(
      ...declarations[kind].map((name) => (directory === "." ? name : `${directory}/${name}`)),
    );
    if (directory === ".") break;
    const slash = directory.lastIndexOf("/");
    directory = slash < 0 ? "." : directory.slice(0, slash);
  }
  return paths;
}

export function createProjectToolchainEvidence(input) {
  if (
    !["filesystem", "github"].includes(input.collector) ||
    typeof input.name !== "string" ||
    !input.name
  )
    throw new Error(
      "Project toolchain evidence requires a supported collector and component identity",
    );
  const candidates = projectToolchainPaths(input.path, input.kind);
  const values = candidates
    .filter((path) => Object.hasOwn(input.files, path))
    .map((path) => ({
      path,
      content: typeof input.files[path] === "string" ? input.files[path] : null,
    }));
  return {
    schemaVersion: NORMALIZED_EVIDENCE_SCHEMA_VERSION,
    component: { name: input.name, path: input.path, kind: input.kind },
    facts: {
      declarations: {
        status: input.complete === false ? "incomplete" : "available",
        value: values,
        provenance: values.map(({ path }) => ({ collector: input.collector, path })),
      },
    },
  };
}

export function collectGithubProjectToolchainEvidence(snapshot, components) {
  const paths = new Map(
    (snapshot.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry.mode]),
  );
  return components
    .filter((component) => Object.hasOwn(declarations, component.kind))
    .map((component) => {
      const files = Object.fromEntries(
        projectToolchainPaths(component.path, component.kind)
          .filter((path) => paths.has(path))
          .map((path) => [
            path,
            paths.get(path) === "120000" ? null : (snapshot.files?.[path] ?? null),
          ]),
      );
      return createProjectToolchainEvidence({
        collector: "github",
        ...component,
        files,
        complete: !snapshot.treeTruncated,
      });
    })
    .toSorted(
      (left, right) =>
        left.component.path.localeCompare(right.component.path) ||
        left.component.kind.localeCompare(right.component.kind),
    );
}

// Deliberately bounded TOML: the native toolchain table, literal strings, and
// literal string arrays. Escapes, inline/dotted tables and unknown keys remain unsupported.
function rustDeclaration(content, legacy) {
  const text = content.trim();
  if (legacy && /^[A-Za-z0-9._+-]+$/.test(text)) return { channel: text };
  const literal = '(?:"[^"\\\\\\n]*"|\x27[^\x27\\n]*\x27)';
  const array = `\\[\\s*(?:${literal}\\s*(?:,\\s*${literal}\\s*)*,?)?\\s*\\]`;
  const assignment = new RegExp(
    `^(channel|path|profile|components|targets)\\s*=\\s*(${literal}|${array})(?:[ \\t]*\\n+|\\s*$)`,
  );
  let source = text
    .replace(/"[^"\\\n]*"|'[^'\n]*'|#[^\n]*/g, (token) => (token.startsWith("#") ? "" : token))
    .trim();
  if (!/^\[toolchain\](?:[ \t]*\n+|\s*$)/.test(source)) return null;
  source = source.slice("[toolchain]".length).trim();
  const fields = {};
  while (source) {
    const match = source.match(assignment);
    if (!match || Object.hasOwn(fields, match[1])) return null;
    const [whole, key, value] = match;
    if ((key === "components" || key === "targets") !== value.startsWith("[")) return null;
    fields[key] = value.startsWith("[") ? value : value.slice(1, -1);
    source = source.slice(whole.length).trim();
  }
  return fields;
}

export function projectToolchainOutcome(evidence) {
  if (
    evidence?.schemaVersion !== NORMALIZED_EVIDENCE_SCHEMA_VERSION ||
    !Object.hasOwn(declarations, evidence?.component?.kind)
  ) {
    throw new Error("Unsupported normalized project toolchain evidence");
  }
  const { kind, path } = evidence.component;
  const facts = evidence.facts.declarations;
  const candidates = projectToolchainPaths(path, kind);
  const selected = candidates
    .map((candidate) => facts.value.find((value) => value.path === candidate))
    .find(Boolean);
  const base = {
    runtime: kind,
    provenance: selected ? facts.provenance.filter((item) => item.path === selected.path) : [],
  };
  if (selected) {
    base.declaration = selected.path;
    const slash = selected.path.lastIndexOf("/");
    const owner = slash < 0 ? "." : selected.path.slice(0, slash);
    if (owner !== path) base.inheritedFrom = owner;
  }
  const outcome = (status, reason, details = {}) => ({ ...base, status, reason, ...details });
  if (facts.status !== "available" || (selected && typeof selected.content !== "string")) {
    return outcome("incomplete", "project-toolchain-evidence-incomplete");
  }
  if (!selected) return outcome("finding", "project-toolchain-missing");
  if (kind === "rust") {
    const parsed = rustDeclaration(
      selected.content,
      selected.path.endsWith("/rust-toolchain") || selected.path === "rust-toolchain",
    );
    if (!parsed || parsed.path || typeof parsed.channel !== "string")
      return outcome("unsupported", "rust-toolchain-shape-unsupported");
    const version = parsed.channel;
    if (exactVersion.test(version))
      return outcome("satisfied", "project-toolchain-exact", { version });
    if (
      /^(?:stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?$/.test(version) ||
      /^\d+\.\d+(?:\..+)?$/.test(version)
    ) {
      return outcome("finding", "project-toolchain-not-exact", { version });
    }
    return outcome("unsupported", "rust-custom-toolchain-unsupported", { version });
  }
  let parsed;
  try {
    parsed = JSON.parse(selected.content);
  } catch {
    return outcome("unsupported", "dotnet-global-json-shape-unsupported");
  }
  const sdk = parsed?.sdk;
  if (!sdk || typeof sdk !== "object" || typeof sdk.version !== "string")
    return outcome("unsupported", "dotnet-sdk-declaration-unsupported");
  const version = sdk.version;
  if (!exactVersion.test(version))
    return outcome("finding", "project-toolchain-not-exact", { version });
  if (sdk.rollForward !== "disable")
    return outcome("finding", "dotnet-sdk-roll-forward-enabled", {
      version,
      rollForward: sdk.rollForward ?? "patch",
    });
  return outcome("satisfied", "project-toolchain-exact", { version, rollForward: "disable" });
}
