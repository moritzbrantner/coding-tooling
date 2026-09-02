import { readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import type { FindingScaffold } from "./expectation-model.ts";
import type { PackageInfo, DetectorContext } from "./expectation-package-context.ts";
import { normalizePath } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix } from "./shared.ts";

const typeScriptSourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
const javaScriptSourceExtensions = [".js", ".jsx", ".mjs", ".cjs"];
const emittedJavaScriptExtensions = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx", ".ts"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
]);

type SourceKind = "typescript" | "javascript";

function testIdentity(path: string, packageInfo: PackageInfo): string | undefined {
  const local = normalizePath(relative(packageInfo.directory, path));
  const withoutRoot = local.startsWith("tests/")
    ? local.slice(6)
    : local.startsWith("src/")
      ? local.slice(4)
      : local;
  const match = /^(.*)\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.exec(withoutRoot);
  return match?.[1];
}

function sourceIdentity(source: string, packageInfo: PackageInfo): string {
  const local = normalizePath(relative(packageInfo.directory, source));
  const withoutRoot = local.startsWith("src/") ? local.slice(4) : local;
  const extension = extname(withoutRoot);
  return withoutRoot.slice(0, -extension.length);
}

function moduleSpecifiers(content: string): string[] {
  const result: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) result.push(match[1]);
    }
  }
  return result;
}

function sourceCandidates(
  importer: string,
  specifier: string,
  sourceExtensions: readonly string[],
  emittedAliases?: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!specifier.startsWith(".")) return [];
  const base = resolve(dirname(importer), specifier);
  const extension = extname(base);
  if (sourceExtensions.includes(extension)) return [base];

  const emittedCandidates = emittedAliases?.get(extension);
  if (emittedCandidates) {
    const withoutExtension = base.slice(0, -extension.length);
    return emittedCandidates.map((candidate) => `${withoutExtension}${candidate}`);
  }

  if (extension) return [];
  return [
    ...sourceExtensions.map((candidate) => `${base}${candidate}`),
    ...sourceExtensions.map((candidate) => join(base, `index${candidate}`)),
  ];
}

function reachableSources(
  packageInfo: PackageInfo,
  sourceFiles: readonly string[],
  sourceExtensions: readonly string[],
  emittedAliases?: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const sources = new Set(sourceFiles.map((path) => resolve(path)));
  const reachable = new Set<string>();
  const queued = new Set<string>(packageInfo.testFiles.map((path) => resolve(path)));
  const queue = [...queued];

  while (queue.length > 0) {
    const importer = queue.shift()!;
    let content: string;
    try {
      content = readFileSync(importer, "utf8");
    } catch {
      continue;
    }
    for (const specifier of moduleSpecifiers(content)) {
      const target = sourceCandidates(importer, specifier, sourceExtensions, emittedAliases).find(
        (candidate) => sources.has(resolve(candidate)),
      );
      if (!target) continue;
      const resolvedTarget = resolve(target);
      if (reachable.has(resolvedTarget)) continue;
      reachable.add(resolvedTarget);
      if (!queued.has(resolvedTarget)) {
        queued.add(resolvedTarget);
        queue.push(resolvedTarget);
      }
    }
  }

  return reachable;
}

function matchingTest(
  source: string,
  packageInfo: PackageInfo,
  testReachability: ReadonlySet<string>,
): string | undefined {
  const identity = sourceIdentity(source, packageInfo);
  const matching = packageInfo.testFiles.find((testFile) => {
    const test = testIdentity(testFile, packageInfo);
    return test === identity || test?.startsWith(`${identity}-`) === true;
  });
  if (matching) return matching;
  return testReachability.has(resolve(source)) ? "<reachable-from-test>" : undefined;
}

function plannedTestPath(
  root: string,
  source: string,
  packageInfo: PackageInfo,
  sourceKind: SourceKind,
): string {
  const local = normalizePath(relative(packageInfo.directory, source));
  const withoutSourceRoot = local.startsWith("src/") ? local.slice(4) : local;
  const extension = extname(withoutSourceRoot);
  const stem = withoutSourceRoot.slice(0, -extension.length);
  const testExtension =
    sourceKind === "typescript"
      ? extension === ".tsx"
        ? ".tsx"
        : ".ts"
      : extension === ".jsx" || extension === ".mjs" || extension === ".cjs"
        ? extension
        : ".js";
  return relativePosix(root, join(packageInfo.directory, "tests", `${stem}.test${testExtension}`));
}

function selectedTestScript(
  packageInfo: PackageInfo,
): { name: string; command: string } | undefined {
  const scripts = packageInfo.manifest.scripts ?? {};
  for (const name of ["test:unit", "test"]) {
    const command = scripts[name];
    if (typeof command === "string" && command.trim()) return { name, command };
  }
  return undefined;
}

function usesBunTestRunner(packageInfo: PackageInfo): boolean {
  const test = selectedTestScript(packageInfo);
  return test !== undefined && /(?:^|[;&|]\s*|\s)bun\s+test(?:\s|$)/.test(test.command.trim());
}

function verificationForTest(packageInfo: PackageInfo, root: string, target: string): string[][] {
  const test = selectedTestScript(packageInfo);
  if (!test) return [];
  const localTarget = normalizePath(relative(packageInfo.directory, join(root, target)));
  if (usesBunTestRunner(packageInfo)) return [["bun", "test", localTarget]];
  return packageInfo.usesBun
    ? [["bun", "run", test.name, "--", localTarget]]
    : [["npm", "run", test.name, "--", localTarget]];
}

function testScaffold(
  source: string,
  target: string,
  packageInfo: PackageInfo,
): FindingScaffold | undefined {
  if (!usesBunTestRunner(packageInfo)) return undefined;
  const sourceLabel = normalizePath(relative(packageInfo.directory, source));
  return {
    kind: "create-file",
    path: target,
    content: `import { describe, test } from "bun:test";

describe(${JSON.stringify(sourceLabel)}, () => {
  test.todo("add deterministic coverage");
});
`,
  };
}

function missingSourceTestFindings(
  root: string,
  packageInfo: PackageInfo,
  sourceFiles: readonly string[],
  sourceExtensions: readonly string[],
  sourceKind: SourceKind,
  emittedAliases?: ReadonlyMap<string, readonly string[]>,
): RawFinding[] {
  if (!selectedTestScript(packageInfo)) return [];
  const testReachability = reachableSources(
    packageInfo,
    sourceFiles,
    sourceExtensions,
    emittedAliases,
  );
  const findings: RawFinding[] = [];
  for (const source of sourceFiles) {
    if (matchingTest(source, packageInfo, testReachability)) continue;
    const sourcePath = relativePosix(root, source);
    const target = plannedTestPath(root, source, packageInfo, sourceKind);
    findings.push({
      subject: {
        kind: "file",
        key: sourcePath,
        path: sourcePath,
        description: `${sourceKind === "typescript" ? "TypeScript" : "JavaScript"} source ${sourcePath}`,
      },
      requirement: {
        kind: "test",
        key: target,
        description: "deterministic structural test reachability",
        expectedArtifact: target,
      },
      message: `${sourcePath} is not deterministically reachable from a test`,
      evidence: [{ kind: "file", path: sourcePath, detail: "production source file exists" }],
      relatedFiles: [sourcePath],
      verification: verificationForTest(packageInfo, root, target),
      scaffold:
        sourceKind === "typescript" ? testScaffold(source, target, packageInfo) : undefined,
    });
  }
  return findings;
}

export function missingTestFindings({ root, packages }: DetectorContext): RawFinding[] {
  return packages.flatMap((packageInfo) =>
    missingSourceTestFindings(
      root,
      packageInfo,
      packageInfo.sourceFiles,
      typeScriptSourceExtensions,
      "typescript",
      emittedJavaScriptExtensions,
    ),
  );
}

export function missingJavaScriptTestFindings({ root, packages }: DetectorContext): RawFinding[] {
  return packages.flatMap((packageInfo) =>
    missingSourceTestFindings(
      root,
      packageInfo,
      packageInfo.javaScriptSourceFiles,
      javaScriptSourceExtensions,
      "javascript",
    ),
  );
}
