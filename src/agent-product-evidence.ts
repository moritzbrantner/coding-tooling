import { lstatSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import * as ts from "typescript";

import { declaredComponents } from "./core.ts";
import { type Capability, capabilities, type Diagnostic } from "./model.ts";
import { type CommandResult, runCommand } from "./shared.ts";
import { containedTaskPath } from "./task-scope-selection.ts";
import { portableTaskPath } from "./task-knowledge-declarations.ts";
import { collectTestDiscoveryEvidence } from "./test-discovery-evidence.ts";
import { isTestCapability } from "./test-execution-evidence.ts";

type Runner = (command: string, args?: string[], cwd?: string, inherit?: boolean) => CommandResult;

export type RevisionedPath = { path: string; revision: string };
export type AcceptanceContract = RevisionedPath & { capability: Capability };
export type ProductAcceptance = {
  specifications: RevisionedPath[];
  contracts: AcceptanceContract[];
  coreSmokeCapabilities: Capability[];
  independentAgentClaim?: string;
};

export type MergeVerificationDecision = {
  mode: "affected" | "full-required";
  reason: string;
  sourceRevision: string;
  selectedTests: string[];
  coreSmokeCapabilities: Capability[];
  coverageBasis: "closed-static-import-graph" | "unproven";
  execution: "not-run" | "full-capability-checks";
};

const shaPattern = /^[0-9a-f]{40}$/i;
const testPattern = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]sx?)$/i;
const modulePattern = /\.(?:[cm]?[jt]sx?)$/i;

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    portableTaskPath(value) &&
    value !== "." &&
    !value.startsWith("./") &&
    value.split("/").every((segment) => segment !== "" && segment !== ".")
  );
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && shaPattern.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeProductAcceptance(
  value: unknown,
): { product?: ProductAcceptance; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!record(value)) {
    return {
      diagnostics: [{ code: "task-product-acceptance-invalid", message: "acceptance.product must be an object" }],
    };
  }
  function references(field: "specifications" | "contracts"): AcceptanceContract[] {
    const entries = value[field];
    if (!Array.isArray(entries) || !entries.length) {
      diagnostics.push({ code: "task-product-references-invalid", message: `product.${field} requires non-empty revisioned paths` });
      return [];
    }
    const refs: AcceptanceContract[] = [];
    for (const item of entries) {
      if (
        !record(item) ||
        !validPath(item.path) ||
        !validSha(item.revision) ||
        (field === "contracts" && !capabilities.includes(item.capability as Capability))
      ) {
        diagnostics.push({ code: "task-product-reference-invalid", message: `product.${field} contains an invalid repository path, revision or capability` });
        continue;
      }
      refs.push({
        path: item.path,
        revision: (item.revision as string).toLowerCase(),
        capability: field === "contracts" ? (item.capability as Capability) : "test",
      });
    }
    const paths = refs.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      diagnostics.push({ code: "task-product-reference-duplicate", message: `product.${field} has duplicate paths` });
    }
    return refs.sort((a, b) => a.path.localeCompare(b.path));
  }
  const specifications = references("specifications").map(({ path, revision }) => ({ path, revision }));
  const contracts = references("contracts");
  const smoke = value.coreSmokeCapabilities;
  if (
    !Array.isArray(smoke) ||
    !smoke.length ||
    smoke.some((capability) => !isTestCapability(capability as Capability) || !capabilities.includes(capability as Capability))
  ) {
    diagnostics.push({ code: "task-product-smoke-invalid", message: "product.coreSmokeCapabilities requires test capabilities" });
  }
  if (
    value.independentAgentClaim !== undefined &&
    (typeof value.independentAgentClaim !== "string" || !value.independentAgentClaim.trim())
  ) {
    diagnostics.push({ code: "task-product-independence-invalid", message: "product.independentAgentClaim must be a non-empty string" });
  }
  if (diagnostics.length) return { diagnostics };
  return {
    product: {
      specifications,
      contracts,
      coreSmokeCapabilities: sorted(smoke as Capability[]) as Capability[],
      ...(typeof value.independentAgentClaim === "string"
        ? { independentAgentClaim: value.independentAgentClaim.trim() }
        : {}),
    },
    diagnostics,
  };
}

/** Validate that each pinned commit precedes HEAD and still has identical content at that path. */
export function validateProductReferences(
  root: string,
  product: ProductAcceptance,
  candidateSha: string,
  runner: Runner = runCommand,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const reference of [...product.specifications, ...product.contracts]) {
    if (!validPath(reference.path) || !containedTaskPath(root, reference.path)) {
      diagnostics.push({ code: "verification-reference-unsafe", path: reference.path, message: "Reference is missing or escapes the repository" });
      continue;
    }
    const absolute = resolve(root, reference.path);
    if (!lstatSync(absolute).isFile()) {
      diagnostics.push({ code: "verification-reference-not-file", path: reference.path, message: "Reference must be a regular repository file" });
      continue;
    }
    const ancestor = runner("git", ["merge-base", "--is-ancestor", reference.revision, candidateSha], root);
    if (ancestor.status !== 0) {
      diagnostics.push({ code: "verification-reference-revision-invalid", path: reference.path, message: "Reference revision is unavailable or not an ancestor of the candidate" });
      continue;
    }
    const oldBlob = runner("git", ["rev-parse", "--verify", `${reference.revision}:${reference.path}`], root);
    const currentBlob = runner("git", ["rev-parse", "--verify", `${candidateSha}:${reference.path}`], root);
    if (
      oldBlob.status !== 0 ||
      currentBlob.status !== 0 ||
      !shaPattern.test(oldBlob.stdout.trim()) ||
      oldBlob.stdout.trim() !== currentBlob.stdout.trim()
    ) {
      diagnostics.push({ code: "verification-reference-stale", path: reference.path, message: "Referenced content is absent or differs from the current candidate revision" });
    }
  }
  return diagnostics;
}

function repositoryPath(root: string, path: string): string | null {
  if (!validPath(path) || !containedTaskPath(root, path)) return null;
  if (!lstatSync(resolve(root, path)).isFile()) return null;
  return path;
}

function specifiers(file: string, content: string): string[] | null {
  const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith("tsx") || file.endsWith("jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const errors = (parsed as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (errors?.length) return null;
  const imports: string[] = [];
  let unsupported = false;
  function add(node: ts.Node | undefined): void {
    if (!node || !ts.isStringLiteral(node)) { unsupported = true; return; }
    imports.push(node.text);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
      else unsupported = true;
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        if (node.arguments.length !== 1) unsupported = true;
        else add(node.arguments[0]);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(parsed) === "import.meta"
      ) unsupported = true;
    } else if (ts.isIdentifier(node) && node.text === "eval") {
      unsupported = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return unsupported ? null : sorted(imports);
}

function resolveRelativeImport(root: string, importer: string, specifier: string): string | null {
  if (specifier === "bun:test" || specifier === "vitest" || specifier.startsWith("node:")) return "";
  if (!specifier.startsWith(".")) return null;
  const absolute = resolve(root, dirname(importer), specifier);
  const extension = extname(absolute);
  const withoutExtension = extension ? absolute.slice(0, -extension.length) : absolute;
  const possible = extension
    ? [absolute, ...([".js", ".jsx", ".mjs", ".cjs"].includes(extension)
      ? [`${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${withoutExtension}.mts`, `${withoutExtension}.cts`]
      : [])]
    : [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => `${absolute}${suffix}`);
  const matched = possible
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((path) => repositoryPath(root, path) !== null);
  return matched.length === 1 ? matched[0]! : null;
}

function testDependencies(root: string, testPath: string): Set<string> | null {
  const reachable = new Set<string>();
  const queue = [testPath];
  while (queue.length) {
    const path = queue.shift()!;
    if (reachable.has(path)) continue;
    if (!modulePattern.test(path) || !repositoryPath(root, path)) return null;
    reachable.add(path);
    const imports = specifiers(path, readFileSync(resolve(root, path), "utf8"));
    if (!imports) return null;
    for (const specifier of imports) {
      const resolved = resolveRelativeImport(root, path, specifier);
      if (resolved === null) return null;
      if (resolved && !reachable.has(resolved)) queue.push(resolved);
    }
  }
  return reachable;
}

function fullDecision(
  candidateSha: string,
  reason: string,
  product: ProductAcceptance,
): MergeVerificationDecision {
  return {
    mode: "full-required",
    reason,
    sourceRevision: candidateSha,
    selectedTests: sorted(product.contracts.map((contract) => contract.path)),
    coreSmokeCapabilities: product.coreSmokeCapabilities,
    coverageBasis: "unproven",
    execution: "not-run",
  };
}

/**
 * Affected selection is permitted only for an exhaustively discovered native test suite
 * and a closed, resolvable static import graph. All ambiguity falls back to the full suite.
 * This selects requirements; actual execution continues through canonical capabilities.
 */
export function selectMergeVerification(
  root: string,
  candidateSha: string,
  changedFiles: string[],
  product: ProductAcceptance,
  runner: Runner = runCommand,
): MergeVerificationDecision {
  const full = (reason: string) => fullDecision(candidateSha, reason, product);
  let components: ReturnType<typeof declaredComponents>;
  try {
    components = declaredComponents(root);
  } catch {
    return full("capability-discovery-unavailable");
  }
  const tests = new Set<string>();
  const paths = components.map((component) => component.path);
  for (const component of components) {
    const command = component.capabilities.test;
    if (!command) continue;
    const excludedSubtrees = paths.filter((path) => path !== component.path && path.startsWith(`${component.path === "." ? "" : component.path + "/"}`))
      .map((path) => relative(resolve(root, component.path), resolve(root, path)).replaceAll("\\", "/"));
    const discovery = collectTestDiscoveryEvidence(
      { cwd:resolve(root, component.path), capability:"test", command, excludedSubtrees },
      runner,
    );
    if (!discovery || discovery.status !== "available" || discovery.truncated ||
      discovery.excludedFileCount !== 0 || !discovery.discoveredFiles ||
      discovery.discoveredFileCount !== discovery.discoveredFiles.length)
      return full("test-discovery-incomplete");
    for (const path of discovery.discoveredFiles) {
      const repoPath = relative(root, resolve(root, component.path, path)).replaceAll("\\", "/");
      if (!repositoryPath(root, repoPath)) return full("test-inventory-unsafe");
      tests.add(repoPath);
    }
  }
  if (!tests.size) return full("test-inventory-unavailable");
  const contracts = product.contracts.map((reference) => reference.path);
  if (contracts.some((path) => !tests.has(path))) return full("acceptance-contract-not-discovered");
  const dependencies = new Map<string, Set<string>>();
  for (const test of [...tests].sort()) {
    const graph = testDependencies(root, test);
    if (!graph) return full("dependency-graph-incomplete");
    dependencies.set(test, graph);
  }
  const selected = new Set(contracts);
  const specificationPaths = new Set(product.specifications.map((reference) => reference.path));
  for (const path of sorted(changedFiles)) {
    if (specificationPaths.has(path)) continue;
    if (!repositoryPath(root, path)) return full("deleted-or-unsafe-change");
    if (tests.has(path)) { selected.add(path); continue; }
    if (!modulePattern.test(path)) return full("shared-boundary-or-unknown-change");
    const affected = [...dependencies].filter(([, graph]) => graph.has(path)).map(([test]) => test);
    if (!affected.length) return full("changed-source-without-proven-test-dependency");
    for (const test of affected) selected.add(test);
  }
  return {
    mode: "affected",
    reason: "closed-dependency-graph-covers-changes",
    sourceRevision: candidateSha,
    selectedTests: sorted([...selected]),
    coreSmokeCapabilities: product.coreSmokeCapabilities,
    coverageBasis: "closed-static-import-graph",
    execution: "not-run",
  };
}
