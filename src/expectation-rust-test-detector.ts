import { basename, dirname, join, relative } from "node:path";

import type { RawFinding } from "./expectation-detector-types.ts";
import {
  normalizePath,
  type DetectorContext,
  type RustPackageInfo,
} from "./expectation-package-context.ts";
import { relativePosix } from "./shared.ts";
import { readFileSync } from "node:fs";

const cfgTestPattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const testAttributePattern = /#\s*\[\s*(?:[A-Za-z_][A-Za-z0-9_]*::)?test(?:\s*\([^\]]*\))?\s*\]/;
const moduleDeclarationPattern =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$/;

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hasInlineTestEvidence(source: string): boolean {
  const content = readSource(source);
  return (
    content !== undefined && cfgTestPattern.test(content) && testAttributePattern.test(content)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function integrationImportsCrate(rustPackage: RustPackageInfo): boolean {
  if (!rustPackage.crateName) return false;
  const crate = escapeRegExp(rustPackage.crateName);
  const importPattern = new RegExp(
    `\\b(?:use\\s+|extern\\s+crate\\s+)${crate}(?=\\s*(?:::|;|\\bas\\b))`,
  );
  return rustPackage.testFiles.some((testFile) => importPattern.test(readSource(testFile) ?? ""));
}

function moduleDirectory(source: string, rustPackage: RustPackageInfo): string {
  const local = normalizePath(relative(rustPackage.directory, source));
  if (local === "src/lib.rs") return join(rustPackage.directory, "src");
  if (basename(source) === "mod.rs") return dirname(source);
  return join(dirname(source), basename(source, ".rs"));
}

function declaredModules(
  source: string,
  rustPackage: RustPackageInfo,
  sourceFiles: ReadonlySet<string>,
): string[] {
  const content = readSource(source);
  if (content === undefined) return [];
  const lines = content.split(/\r?\n/);
  const directory = moduleDirectory(source, rustPackage);
  const result: string[] = [];
  let previousCode = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const match = moduleDeclarationPattern.exec(line);
    if (match?.[1] && !previousCode.startsWith("#[")) {
      const candidates = [
        join(directory, `${match[1]}.rs`),
        join(directory, match[1], "mod.rs"),
      ].filter((candidate) => sourceFiles.has(candidate));
      if (candidates.length === 1) result.push(candidates[0]!);
    }
    previousCode = trimmed;
  }

  return result;
}

function librarySources(rustPackage: RustPackageInfo): string[] {
  const sourceFiles = new Set(rustPackage.sourceFiles);
  const root = rustPackage.sourceFiles.find(
    (source) => normalizePath(relative(rustPackage.directory, source)) === "src/lib.rs",
  );
  if (!root) return [];

  const reachable = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const child of declaredModules(source, rustPackage, sourceFiles)) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      queue.push(child);
    }
  }
  return [...reachable].sort();
}

function verification(root: string, rustPackage: RustPackageInfo): string[][] {
  return [
    ["cargo", "test", "--locked", "--manifest-path", relativePosix(root, rustPackage.manifestPath)],
  ];
}

export function missingRustTestFindings({ root, rustPackages }: DetectorContext): RawFinding[] {
  const findings: RawFinding[] = [];

  for (const rustPackage of rustPackages) {
    const integrationEvidence = integrationImportsCrate(rustPackage);
    for (const source of librarySources(rustPackage)) {
      if (integrationEvidence || hasInlineTestEvidence(source)) continue;

      const sourcePath = relativePosix(root, source);
      findings.push({
        subject: {
          kind: "file",
          key: sourcePath,
          path: sourcePath,
          description: `Rust source ${sourcePath}`,
        },
        requirement: {
          kind: "test",
          key: `rust-test:${sourcePath}`,
          description: "conservative Rust test evidence",
        },
        message: `${sourcePath} has no conservative Rust test evidence`,
        evidence: [
          { kind: "file", path: sourcePath, detail: "production Rust source file exists" },
        ],
        relatedFiles: [sourcePath],
        verification: verification(root, rustPackage),
      });
    }
  }

  return findings;
}
