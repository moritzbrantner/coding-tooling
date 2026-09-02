import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import type { RawFinding } from "./expectation-detector-types.ts";
import {
  normalizePath,
  type DetectorContext,
  type RustPackageInfo,
} from "./expectation-package-context.ts";
import { relativePosix } from "./shared.ts";

const cfgTestPattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const testAttributePattern = /#\s*\[\s*(?:[A-Za-z_][A-Za-z0-9_]*::)?test(?:\s*\([^\]]*\))?\s*\]/;
const moduleItemPattern =
  /\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*([;{])/g;
const trailingAttributePattern = /(?:#\s*\[[^\]]*\]\s*)+$/;

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function blankNonNewlines(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
}

function rawStringAt(
  content: string,
  index: number,
): { openEnd: number; close: string } | undefined {
  let cursor = index;
  if (content[cursor] === "r") {
    cursor += 1;
  } else if ((content[cursor] === "b" || content[cursor] === "c") && content[cursor + 1] === "r") {
    cursor += 2;
  } else {
    return undefined;
  }

  let hashes = 0;
  while (content[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }
  if (content[cursor] !== '"') return undefined;
  return { openEnd: cursor + 1, close: `"${"#".repeat(hashes)}` };
}

function characterLiteralEnd(content: string, index: number): number | undefined {
  let quote = index;
  if (content[index] === "b" && content[index + 1] === "'") {
    quote = index + 1;
  } else if (content[index] !== "'") {
    return undefined;
  }

  let cursor = quote + 1;
  if (cursor >= content.length || content[cursor] === "\n" || content[cursor] === "\r") {
    return undefined;
  }

  if (content[cursor] === "\\") {
    cursor += 1;
    if (content[cursor] === "u" && content[cursor + 1] === "{") {
      const close = content.indexOf("}", cursor + 2);
      if (close < 0) return undefined;
      cursor = close + 1;
    } else if (content[cursor] === "x") {
      cursor += 3;
    } else {
      cursor += 1;
    }
  } else {
    const codePoint = content.codePointAt(cursor);
    if (codePoint === undefined) return undefined;
    cursor += codePoint > 0xffff ? 2 : 1;
  }

  return content[cursor] === "'" ? cursor + 1 : undefined;
}

function rustCodeOnly(content: string): string {
  const chars = content.split("");
  let index = 0;

  while (index < content.length) {
    if (content.startsWith("//", index)) {
      const end = content.indexOf("\n", index + 2);
      const stop = end < 0 ? content.length : end;
      blankNonNewlines(chars, index, stop);
      index = stop;
      continue;
    }

    if (content.startsWith("/*", index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < content.length && depth > 0) {
        if (content.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (content.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      blankNonNewlines(chars, index, cursor);
      index = cursor;
      continue;
    }

    const raw = rawStringAt(content, index);
    if (raw) {
      const closeIndex = content.indexOf(raw.close, raw.openEnd);
      const stop = closeIndex < 0 ? content.length : closeIndex + raw.close.length;
      blankNonNewlines(chars, index, stop);
      index = stop;
      continue;
    }

    const characterEnd = characterLiteralEnd(content, index);
    if (characterEnd !== undefined) {
      blankNonNewlines(chars, index, characterEnd);
      index = characterEnd;
      continue;
    }

    if (content[index] === '"') {
      let cursor = index + 1;
      while (cursor < content.length) {
        if (content[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (content[cursor - 1] === '"') break;
      }
      blankNonNewlines(chars, index, cursor);
      index = cursor;
      continue;
    }

    index += 1;
  }

  return chars.join("");
}

function hasInlineTestEvidence(source: string): boolean {
  const content = readSource(source);
  if (content === undefined) return false;
  const code = rustCodeOnly(content);
  return cfgTestPattern.test(code) && testAttributePattern.test(code);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moduleDirectory(source: string, roots: ReadonlySet<string>): string {
  if (roots.has(source)) return dirname(source);
  if (basename(source) === "mod.rs") return dirname(source);
  return join(dirname(source), basename(source, ".rs"));
}

type ModuleScope = {
  name: string;
  depth: number;
};

function advanceBraces(
  code: string,
  start: number,
  end: number,
  state: { depth: number; scopes: ModuleScope[] },
): void {
  for (let index = start; index < end; index += 1) {
    if (code[index] === "{") {
      state.depth += 1;
    } else if (code[index] === "}") {
      state.depth = Math.max(0, state.depth - 1);
      while ((state.scopes.at(-1)?.depth ?? 0) > state.depth) state.scopes.pop();
    }
  }
}

function declaredModules(
  source: string,
  rustFiles: ReadonlySet<string>,
  roots: ReadonlySet<string>,
): string[] {
  const content = readSource(source);
  if (content === undefined) return [];
  const code = rustCodeOnly(content);
  const directory = moduleDirectory(source, roots);
  const result = new Set<string>();
  const state = { depth: 0, scopes: [] as ModuleScope[] };
  let scanPosition = 0;

  for (const match of code.matchAll(moduleItemPattern)) {
    if (match.index === undefined || !match[1] || !match[2]) continue;
    advanceBraces(code, scanPosition, match.index, state);

    const expectedDepth = state.scopes.at(-1)?.depth ?? 0;
    const attributed = trailingAttributePattern.test(code.slice(scanPosition, match.index));
    const atModuleItemDepth = state.depth === expectedDepth;
    const name = match[1];
    const terminator = match[2];

    if (atModuleItemDepth && !attributed && terminator === ";") {
      const scopeDirectory = join(directory, ...state.scopes.map((scope) => scope.name));
      const candidates = [
        join(scopeDirectory, `${name}.rs`),
        join(scopeDirectory, name, "mod.rs"),
      ].filter((candidate) => rustFiles.has(candidate));
      if (candidates.length === 1) result.add(candidates[0]!);
    }

    if (terminator === "{") {
      state.depth += 1;
      if (atModuleItemDepth && !attributed) {
        state.scopes.push({ name, depth: state.depth });
      }
    }

    scanPosition = match.index + match[0].length;
  }

  return [...result].sort();
}

function reachableModules(roots: readonly string[], rustPackage: RustPackageInfo): string[] {
  const rootSet = new Set(roots);
  const rustFiles = new Set(rustPackage.rustFiles);
  const reachable = new Set(roots.filter((root) => rustFiles.has(root)));
  const queue = [...reachable];

  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const child of declaredModules(source, rustFiles, rootSet)) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      queue.push(child);
    }
  }

  return [...reachable].sort();
}

function librarySources(rustPackage: RustPackageInfo): string[] {
  const root = rustPackage.sourceFiles.find(
    (source) => normalizePath(relative(rustPackage.directory, source)) === "src/lib.rs",
  );
  return root ? reachableModules([root], rustPackage) : [];
}

function integrationImportsCrate(rustPackage: RustPackageInfo): boolean {
  if (!rustPackage.crateName) return false;
  const crate = escapeRegExp(rustPackage.crateName);
  const importPattern = new RegExp(
    `\\b(?:use\\s+|extern\\s+crate\\s+)${crate}(?=\\s*(?:::|;|\\bas\\b))`,
  );
  return reachableModules(rustPackage.integrationTestRoots, rustPackage).some((source) => {
    const content = readSource(source);
    return content !== undefined && importPattern.test(rustCodeOnly(content));
  });
}

function verification(root: string, rustPackage: RustPackageInfo): string[][] {
  const command = ["cargo", "test"];
  if (rustPackage.hasLockfile) command.push("--locked");
  command.push("--manifest-path", relativePosix(root, rustPackage.manifestPath));
  return [command];
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
