import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type Selection = { path: string; extensions: string[] };
type Target = {
  id: string;
  kind: "web" | "native";
  entrypoint: string;
  artifacts: Selection[];
  target: string;
  profile: string;
  features: string[];
  minification: string;
  toolchains: string[][];
  buildInputs: string[];
  maxBytes: number;
  maxIncreaseBytes: number | null;
};
type Artifact = { path: string; bytes: number; sha256: string };
type Comparison =
  | { state: "not-requested" }
  | { state: "incomparable"; reason: string }
  | { state: "comparable"; baselineBytes: number; deltaBytes: number };
type Measurement = {
  id: string;
  kind: Target["kind"];
  identity: string;
  inputs: Omit<Target, "maxBytes" | "maxIncreaseBytes"> & {
    toolVersions: string[];
    buildInputHashes: { path: string; sha256: string }[];
  };
  bytes: number;
  artifacts: Artifact[];
  comparison: Comparison;
  failures: string[];
};
type SizeData = {
  schemaVersion: "coding-tooling/size-evidence/v1";
  metric: "raw-artifact-bytes";
  targets: Measurement[];
};
export type SizeEvidenceResult = {
  schemaVersion: 1;
  operation: "size-evidence";
  status: "passed" | "failed" | "unavailable" | "error";
  durationMs: number;
  data: SizeData;
  diagnostics: { message: string }[];
};
class Unavailable extends Error {}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown size declaration field.");
  }
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}
function bytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function sorted<T>(values: T[], compare?: (left: T, right: T) => number): T[] {
  // ES2022 is the repository's declared library; sort only an owned copy.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...values].sort(compare);
}
function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
function canonicalPath(value: unknown): string {
  if (
    !text(value) ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error("Size paths must be canonical relative paths inside the repository.");
  }
  return value;
}
function parseTarget(item: unknown): Target {
  if (
    !record(item) ||
    !text(item.id) ||
    (item.kind !== "web" && item.kind !== "native") ||
    !text(item.target) ||
    !text(item.profile) ||
    !text(item.minification) ||
    !strings(item.features) ||
    !bytes(item.maxBytes) ||
    (item.maxIncreaseBytes !== undefined && !bytes(item.maxIncreaseBytes)) ||
    !Array.isArray(item.artifacts) ||
    item.artifacts.length === 0 ||
    !strings(item.buildInputs) ||
    item.buildInputs.length === 0 ||
    !Array.isArray(item.toolchains) ||
    item.toolchains.length === 0
  ) {
    throw new Error("Invalid size target identity, selectors, toolchains or budgets.");
  }
  keys(item, [
    "id",
    "kind",
    "entrypoint",
    "artifacts",
    "target",
    "profile",
    "features",
    "minification",
    "toolchains",
    "buildInputs",
    "maxBytes",
    "maxIncreaseBytes",
  ]);
  const artifacts = item.artifacts.map((selector: unknown): Selection => {
    if (!record(selector) || (selector.extensions !== undefined && !strings(selector.extensions))) {
      throw new Error("Invalid artifact selection.");
    }
    keys(selector, ["path", "extensions"]);
    const extensions = selector.extensions ?? [];
    if (
      !Array.isArray(extensions) ||
      !extensions.every((extension: string) => /^\.[a-zA-Z0-9]+$/.test(extension))
    ) {
      throw new Error("Artifact extensions must be explicit suffixes such as .js.");
    }
    return { path: canonicalPath(selector.path), extensions: sorted(extensions) };
  });
  const toolchains = item.toolchains.map((command: unknown): string[] => {
    if (!Array.isArray(command) || command.length === 0 || !command.every(text)) {
      throw new Error("Toolchain probes must be non-empty argument vectors.");
    }
    return command;
  });
  return {
    id: item.id,
    kind: item.kind,
    entrypoint: canonicalPath(item.entrypoint),
    artifacts: sorted(artifacts, (left, right) =>
      comparePaths(JSON.stringify(left), JSON.stringify(right)),
    ),
    target: item.target,
    profile: item.profile,
    features: sorted(item.features),
    minification: item.minification,
    toolchains,
    buildInputs: sorted(item.buildInputs.map(canonicalPath)),
    maxBytes: item.maxBytes,
    maxIncreaseBytes: item.maxIncreaseBytes ?? null,
  };
}
function declaration(root: string): Target[] {
  const path = join(root, ".performance/size.json");
  if (!existsSync(path)) {
    throw new Unavailable("Missing .performance/size.json declaration.");
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    throw new Error("Size declaration requires schemaVersion 1 and non-empty targets.");
  }
  keys(value, ["schemaVersion", "targets"]);
  const targets = value.targets.map(parseTarget);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) {
    throw new Error("Size target IDs must be unique.");
  }
  return sorted(targets, (left, right) => comparePaths(left.id, right.id));
}
function select(root: string, target: Target): Artifact[] {
  const selected = new Map<string, Artifact>();
  let visited = 0;
  function visit(path: string, extensions: string[], depth: number): void {
    visited += 1;
    if (depth > 32 || visited > 10000) {
      throw new Error("Size artifact selection exceeds its traversal bound.");
    }
    const absolute = join(root, path);
    // Check every ancestor: a directory symlink must not redirect a declared file.
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if (!existsSync(current)) {
        throw new Unavailable(`Missing built artifact: ${path}`);
      }
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Symlink artifact boundary is unsupported: ${path}`);
      }
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      if (extensions.length === 0) {
        throw new Error(`Directory artifact requires explicit extensions: ${path}`);
      }
      for (const name of sorted(readdirSync(absolute))) {
        visit(`${path}/${name}`, extensions, depth + 1);
      }
    } else if (stat.isFile()) {
      if (extensions.length > 0 && !extensions.some((extension) => path.endsWith(extension))) {
        return;
      }
      if (stat.size > 256 * 1024 * 1024) {
        throw new Unavailable(`Artifact exceeds the 256 MiB collector bound: ${path}`);
      }
      const contents = readFileSync(absolute);
      selected.set(path, { path, bytes: contents.byteLength, sha256: hash(contents) });
    } else {
      throw new Error(`Unsupported artifact file type: ${path}`);
    }
  }
  for (const selector of target.artifacts) {
    visit(selector.path, selector.extensions, 0);
  }
  if (selected.size === 0 || !selected.has(target.entrypoint)) {
    throw new Unavailable(`No selected built entrypoint: ${target.entrypoint}`);
  }
  return sorted([...selected.values()], (left, right) => comparePaths(left.path, right.path));
}
function probe(root: string, command: string[]): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Unavailable(`Toolchain probe unavailable: ${command.join(" ")}`);
  }
  return result.stdout.trim();
}
type Baseline = { id: string; identity: string; bytes: number };
function readBaseline(root: string, path: string): Baseline[] {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    throw new Unavailable(`Requested size baseline is missing: ${path}`);
  }
  const value: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.operation !== "size-evidence" ||
    !["passed", "failed"].includes(String(value.status)) ||
    !record(value.data) ||
    value.data.schemaVersion !== "coding-tooling/size-evidence/v1" ||
    value.data.metric !== "raw-artifact-bytes" ||
    !Array.isArray(value.data.targets) ||
    value.data.targets.length === 0
  ) {
    throw new Error("Baseline must be a completed coding-tooling/size-evidence/v1 measurement.");
  }
  const values = value.data.targets.map((item: unknown): Baseline => {
    if (
      !record(item) ||
      !text(item.id) ||
      !text(item.identity) ||
      !/^[a-f0-9]{64}$/.test(item.identity) ||
      !record(item.inputs) ||
      hash(JSON.stringify(item.inputs)) !== item.identity ||
      !bytes(item.bytes) ||
      !Array.isArray(item.artifacts) ||
      item.artifacts.length === 0
    ) {
      throw new Error("Invalid baseline measurement.");
    }
    const { toolVersions, buildInputHashes, ...declaredInputs } = item.inputs;
    const target = parseTarget({ ...declaredInputs, maxBytes: 0 });
    if (
      target.id !== item.id ||
      target.kind !== item.kind ||
      !Array.isArray(toolVersions) ||
      toolVersions.length !== target.toolchains.length ||
      !toolVersions.every(text) ||
      !Array.isArray(buildInputHashes) ||
      buildInputHashes.length !== target.buildInputs.length
    ) {
      throw new Error("Invalid baseline build identity.");
    }
    for (const [index, input] of buildInputHashes.entries()) {
      if (
        !record(input) ||
        input.path !== target.buildInputs[index] ||
        !text(input.sha256) ||
        !/^[a-f0-9]{64}$/.test(input.sha256)
      ) {
        throw new Error("Invalid baseline build input hash.");
      }
    }
    let total = 0;
    const paths = new Set<string>();
    for (const artifact of item.artifacts) {
      if (
        !record(artifact) ||
        !text(artifact.path) ||
        !bytes(artifact.bytes) ||
        !text(artifact.sha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)
      ) {
        throw new Error("Invalid baseline artifact.");
      }
      const artifactPath = canonicalPath(artifact.path);
      if (
        !target.artifacts.some(
          (selector) =>
            (artifactPath === selector.path ||
              (selector.extensions.length > 0 && artifactPath.startsWith(`${selector.path}/`))) &&
            (selector.extensions.length === 0 ||
              selector.extensions.some((extension) => artifactPath.endsWith(extension))),
        )
      ) {
        throw new Error("Baseline artifact is outside its declared selection.");
      }
      if (paths.has(artifact.path)) {
        throw new Error("Duplicate baseline artifact path.");
      }
      paths.add(artifact.path);
      total += artifact.bytes;
    }
    if (!paths.has(target.entrypoint)) {
      throw new Error("Baseline artifact selection is missing its declared entrypoint.");
    }
    if (total !== item.bytes) {
      throw new Error("Baseline artifact byte total does not match its measurement.");
    }
    return { id: item.id, identity: item.identity, bytes: item.bytes };
  });
  if (new Set(values.map((item) => item.id)).size !== values.length) {
    throw new Error("Duplicate baseline target IDs.");
  }
  return values;
}

/** Read built artifacts; never build, install, modify budgets or refresh baselines. */
export function sizeEvidence(
  root: string,
  options: { baseline?: string } = {},
): SizeEvidenceResult {
  const started = Date.now();
  const data: SizeData = {
    schemaVersion: "coding-tooling/size-evidence/v1",
    metric: "raw-artifact-bytes",
    targets: [],
  };
  try {
    root = resolve(root);
    const targets = declaration(root);
    const baseline = options.baseline === undefined ? null : readBaseline(root, options.baseline);
    for (const target of targets) {
      const { maxBytes, maxIncreaseBytes, ...identityInputs } = target;
      const inputs = {
        ...identityInputs,
        toolVersions: target.toolchains.map((command) => probe(root, command)),
        buildInputHashes: target.buildInputs.map((path) => {
          const inputTarget = {
            ...target,
            entrypoint: path,
            artifacts: [{ path, extensions: [] }],
          };
          const [input] = select(root, inputTarget);
          if (!input || input.path !== path) {
            throw new Error(`Build input must be a regular file: ${path}`);
          }
          return { path, sha256: input.sha256 };
        }),
      };
      const identity = hash(JSON.stringify(inputs));
      const artifacts = select(root, target);
      const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
      const failures: string[] = [];
      if (total > maxBytes) {
        failures.push(`Artifact size ${total} exceeds ${maxBytes} bytes.`);
      }
      let comparison: Comparison = { state: "not-requested" };
      if (baseline !== null) {
        const previous = baseline.find((item) => item.id === target.id);
        if (!previous || previous.identity !== identity) {
          comparison = {
            state: "incomparable",
            reason: "Baseline target identity or selection differs.",
          };
        } else {
          const deltaBytes = total - previous.bytes;
          comparison = { state: "comparable", baselineBytes: previous.bytes, deltaBytes };
          if (maxIncreaseBytes !== null && deltaBytes > maxIncreaseBytes) {
            failures.push(`Size increase ${deltaBytes} exceeds ${maxIncreaseBytes} bytes.`);
          }
        }
      }
      data.targets.push({
        id: target.id,
        kind: target.kind,
        identity,
        inputs,
        bytes: total,
        artifacts,
        comparison,
        failures,
      });
    }
    const incomparable = data.targets.some((target) => target.comparison.state === "incomparable");
    const failed = data.targets.some((target) => target.failures.length > 0);
    let status: "passed" | "failed" | "unavailable" = "passed";
    if (incomparable) {
      status = "unavailable";
    } else if (failed) {
      status = "failed";
    }
    return {
      schemaVersion: 1,
      operation: "size-evidence",
      status,
      durationMs: Date.now() - started,
      data,
      diagnostics: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      operation: "size-evidence",
      status: error instanceof Unavailable ? "unavailable" : "error",
      durationMs: Date.now() - started,
      data,
      diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
