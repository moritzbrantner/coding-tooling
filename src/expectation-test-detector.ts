import { readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

import type { FindingScaffold } from "./expectation-model.ts";
import type { PackageInfo, DetectorContext } from "./expectation-package-context.ts";
import { normalizePath } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix } from "./shared.ts";

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

function testDirectlyReferencesSource(source: string, testFile: string): boolean {
  let content: string;
  try {
    content = readFileSync(testFile, "utf8");
  } catch {
    return false;
  }
  const relativeImport = normalizePath(relative(dirname(testFile), source));
  const specifier = relativeImport.startsWith(".") ? relativeImport : `./${relativeImport}`;
  const extension = extname(specifier);
  const extensionless = extension ? specifier.slice(0, -extension.length) : specifier;
  return moduleSpecifiers(content).some(
    (candidate) => candidate === specifier || candidate === extensionless,
  );
}

function matchingTest(source: string, packageInfo: PackageInfo): string | undefined {
  const identity = sourceIdentity(source, packageInfo);
  return packageInfo.testFiles.find((testFile) => {
    const test = testIdentity(testFile, packageInfo);
    return (
      test === identity ||
      test?.startsWith(`${identity}-`) === true ||
      testDirectlyReferencesSource(source, testFile)
    );
  });
}

function plannedTestPath(root: string, source: string, packageInfo: PackageInfo): string {
  const local = normalizePath(relative(packageInfo.directory, source));
  const withoutSourceRoot = local.startsWith("src/") ? local.slice(4) : local;
  const extension = extname(withoutSourceRoot);
  const stem = withoutSourceRoot.slice(0, -extension.length);
  const testExtension = extension === ".tsx" ? ".tsx" : ".ts";
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

export function missingTestFindings({ root, packages }: DetectorContext): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const packageInfo of packages) {
    if (!selectedTestScript(packageInfo)) continue;
    for (const source of packageInfo.sourceFiles) {
      if (matchingTest(source, packageInfo)) continue;
      const sourcePath = relativePosix(root, source);
      const target = plannedTestPath(root, source, packageInfo);
      findings.push({
        subject: {
          kind: "file",
          key: sourcePath,
          path: sourcePath,
          description: `TypeScript source ${sourcePath}`,
        },
        requirement: {
          kind: "test",
          key: target,
          description: "deterministic structural test evidence",
          expectedArtifact: target,
        },
        message: `${sourcePath} has no matching structural test evidence`,
        evidence: [{ kind: "file", path: sourcePath, detail: "source file exists" }],
        relatedFiles: [sourcePath],
        verification: verificationForTest(packageInfo, root, target),
        scaffold: testScaffold(source, target, packageInfo),
      });
    }
  }
  return findings;
}
