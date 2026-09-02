import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { RawFinding } from "./expectation-detector-types.ts";
import {
  normalizePath,
  type DetectorContext,
  type RustPackageInfo,
} from "./expectation-package-context.ts";
import { relativePosix } from "./shared.ts";

const cfgTestPattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const testAttributePattern = /#\s*\[\s*(?:[A-Za-z_][A-Za-z0-9_]*::)?test(?:\s*\([^\]]*\))?\s*\]/;

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hasInlineTestEvidence(source: string): boolean {
  const content = readSource(source);
  return content !== undefined && cfgTestPattern.test(content) && testAttributePattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moduleSegments(source: string, rustPackage: RustPackageInfo): string[] | undefined {
  const local = normalizePath(relative(rustPackage.directory, source));
  if (local === "src/lib.rs") return [];
  if (local === "src/main.rs" || local.startsWith("src/bin/")) return undefined;
  if (!local.startsWith("src/") || !local.endsWith(".rs")) return undefined;

  const segments = local.slice("src/".length).split("/");
  const file = segments.pop();
  if (!file) return undefined;
  if (file !== "mod.rs") segments.push(file.slice(0, -".rs".length));
  return segments;
}

function groupedUseReferences(
  content: string,
  crate: string,
  segments: readonly string[],
): boolean {
  if (segments.length === 0) return false;
  const grouped = new RegExp(`\\buse\\s+${crate}\\s*::\\s*\\{([\\s\\S]*?)\\}\\s*;`, "g");
  const path = segments.map(escapeRegExp).join("\\s*::\\s*");
  const member = new RegExp(`(?:^|,)\\s*${path}(?=\\s*(?:::|,|\\bas\\b|$))`, "m");
  return [...content.matchAll(grouped)].some((match) => member.test(match[1] ?? ""));
}

function testReferencesSource(
  source: string,
  testFile: string,
  rustPackage: RustPackageInfo,
): boolean {
  if (!rustPackage.crateName) return false;
  const content = readSource(testFile);
  if (content === undefined) return false;

  const crate = escapeRegExp(rustPackage.crateName);
  const segments = moduleSegments(source, rustPackage);
  if (segments === undefined) return false;

  if (segments.length === 0) {
    return new RegExp(`\\b(?:use\\s+|extern\\s+crate\\s+)${crate}(?=\\s*(?:::|;))`).test(content);
  }

  const path = [crate, ...segments.map(escapeRegExp)].join("\\s*::\\s*");
  return (
    new RegExp(`\\buse\\s+${path}(?=\\s*(?:::|\\{|;))`).test(content) ||
    groupedUseReferences(content, crate, segments)
  );
}

function hasIntegrationTestEvidence(source: string, rustPackage: RustPackageInfo): boolean {
  return rustPackage.testFiles.some((testFile) => testReferencesSource(source, testFile, rustPackage));
}

function verification(root: string, rustPackage: RustPackageInfo): string[][] {
  return [
    [
      "cargo",
      "test",
      "--locked",
      "--manifest-path",
      relativePosix(root, rustPackage.manifestPath),
    ],
  ];
}

export function missingRustTestFindings({ root, rustPackages }: DetectorContext): RawFinding[] {
  const findings: RawFinding[] = [];

  for (const rustPackage of rustPackages) {
    for (const source of rustPackage.sourceFiles) {
      if (hasInlineTestEvidence(source) || hasIntegrationTestEvidence(source, rustPackage)) continue;

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
        evidence: [{ kind: "file", path: sourcePath, detail: "production Rust source file exists" }],
        relatedFiles: [sourcePath],
        verification: verification(root, rustPackage),
      });
    }
  }

  return findings;
}
