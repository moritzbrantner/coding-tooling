import { readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import type { Component } from "./model.ts";
import { walkFiles } from "./shared.ts";

type RustToken = {
  text: string;
  line: number;
};

type RustItem = {
  group: number;
  label: string;
  line: number;
  end: number;
  bodyOpen?: number;
  bodyClose?: number;
  nestedModule: boolean;
  traitBody: boolean;
};

export type RustSourceOrderingOutcome = {
  status: "passed" | "failed";
  stderr?: string;
};

function componentRoot(root: string, component: Component): string {
  return component.path === "." ? root : join(root, component.path);
}

function tokenizeRust(source: string): RustToken[] {
  const tokens: RustToken[] = [];
  let index = 0;
  let line = 1;

  const advance = (count = 1): void => {
    for (let offset = 0; offset < count; offset += 1) {
      if (source[index + offset] === "\n") line += 1;
    }
    index += count;
  };

  const skipQuoted = (quote: string): void => {
    advance();
    while (index < source.length) {
      if (source[index] === "\\") {
        advance(Math.min(2, source.length - index));
        continue;
      }
      if (source[index] === quote) {
        advance();
        return;
      }
      advance();
    }
  };

  const rawString = (): { prefixLength: number; hashes: string } | undefined => {
    const match = source.slice(index).match(/^(?:b|c)?r(#{0,255})"/);
    if (!match) return undefined;
    return { prefixLength: match[0].length, hashes: match[1] ?? "" };
  };

  const skipRawString = (prefixLength: number, hashes: string): void => {
    advance(prefixLength);
    const terminator = `"${hashes}`;
    while (index < source.length) {
      if (source.startsWith(terminator, index)) {
        advance(terminator.length);
        return;
      }
      advance();
    }
  };

  const skipBlockComment = (): void => {
    let depth = 1;
    advance(2);
    while (index < source.length && depth > 0) {
      if (source.startsWith("/*", index)) {
        depth += 1;
        advance(2);
      } else if (source.startsWith("*/", index)) {
        depth -= 1;
        advance(2);
      } else {
        advance();
      }
    }
  };

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(char)) {
      advance();
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (char === "/" && next === "*") {
      skipBlockComment();
      continue;
    }

    const raw = rawString();
    if (raw) {
      skipRawString(raw.prefixLength, raw.hashes);
      continue;
    }
    if ((char === "b" || char === "c") && next === '"') {
      advance();
      skipQuoted('"');
      continue;
    }
    if (char === '"') {
      skipQuoted('"');
      continue;
    }
    if (char === "b" && next === "'") {
      advance();
      skipQuoted("'");
      continue;
    }
    if (char === "'") {
      const closing = source.indexOf("'", index + 1);
      const newline = source.indexOf("\n", index + 1);
      if (closing >= 0 && (newline < 0 || closing < newline) && closing - index <= 6) {
        skipQuoted("'");
        continue;
      }
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      const tokenLine = line;
      advance();
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) advance();
      if (source.slice(start, index) === "r" && source[index] === "#") {
        advance();
        while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) advance();
      }
      tokens.push({ text: source.slice(start, index), line: tokenLine });
      continue;
    }

    const compound = ["::", "->", "=>", "..=", "..."].find((value) =>
      source.startsWith(value, index),
    );
    if (compound) {
      tokens.push({ text: compound, line });
      advance(compound.length);
      continue;
    }

    tokens.push({ text: char, line });
    advance();
  }

  return tokens;
}

function matchingBraces(tokens: RustToken[]): Map<number, number> {
  const stack: number[] = [];
  const matches = new Map<number, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.text === "{") stack.push(index);
    else if (token.text === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        matches.set(open, index);
        matches.set(index, open);
      }
    }
  }
  return matches;
}

function skipBalanced(
  tokens: RustToken[],
  start: number,
  open: string,
  close: string,
  limit: number,
): number {
  if (tokens[start]?.text !== open) return start;
  let depth = 1;
  let cursor = start + 1;
  while (cursor < limit && depth > 0) {
    if (tokens[cursor]!.text === open) depth += 1;
    else if (tokens[cursor]!.text === close) depth -= 1;
    cursor += 1;
  }
  return cursor;
}

function skipAttributes(tokens: RustToken[], start: number, limit: number): number {
  let cursor = start;
  while (cursor < limit && tokens[cursor]?.text === "#") {
    cursor += 1;
    if (tokens[cursor]?.text === "!") cursor += 1;
    if (tokens[cursor]?.text !== "[") return start;
    cursor = skipBalanced(tokens, cursor, "[", "]", limit);
  }
  return cursor;
}

function isCfgTestItem(tokens: RustToken[], start: number, limit: number): boolean {
  let cursor = start;
  while (cursor < limit && tokens[cursor]?.text === "#") {
    cursor += 1;
    if (tokens[cursor]?.text === "!") cursor += 1;
    if (tokens[cursor]?.text !== "[") return false;
    const bracket = cursor;
    const next = skipBalanced(tokens, bracket, "[", "]", limit);
    const attribute = tokens
      .slice(bracket + 1, Math.max(bracket + 1, next - 1))
      .map((token) => token.text)
      .join("");
    if (attribute === "cfg(test)") return true;
    cursor = next;
  }
  return false;
}

function skipVisibility(tokens: RustToken[], start: number, limit: number): number {
  if (tokens[start]?.text !== "pub") return start;
  let cursor = start + 1;
  if (tokens[cursor]?.text === "(") {
    cursor = skipBalanced(tokens, cursor, "(", ")", limit);
  }
  return cursor;
}

function macroLike(tokens: RustToken[], start: number, limit: number): boolean {
  let cursor = start;
  while (cursor < limit) {
    const text = tokens[cursor]!.text;
    if (text === "!") return true;
    if (text === ";" || text === "{" || text === "=") return false;
    if (!(text === "::" || /^[A-Za-z_][A-Za-z0-9_#]*$/.test(text))) return false;
    cursor += 1;
  }
  return false;
}

function functionAfterQualifier(tokens: RustToken[], start: number, limit: number): boolean {
  let cursor = start;
  const qualifiers = new Set(["async", "const", "unsafe", "extern", "default"]);
  while (cursor < limit) {
    const text = tokens[cursor]!.text;
    if (text === "fn") return true;
    if (!qualifiers.has(text)) return false;
    cursor += 1;
  }
  return false;
}

function classifyRustItem(
  tokens: RustToken[],
  start: number,
  limit: number,
):
  | {
      group: number;
      label: string;
      mode: "body" | "semicolon" | "either";
      nestedModule: boolean;
      traitBody: boolean;
    }
  | undefined {
  let cursor = skipAttributes(tokens, start, limit);
  cursor = skipVisibility(tokens, cursor, limit);
  if (cursor >= limit) return undefined;
  const first = tokens[cursor]!.text;

  if (first === "mod") {
    return { group: 0, label: "module", mode: "either", nestedModule: true, traitBody: false };
  }
  if (first === "extern") {
    if (tokens[cursor + 1]?.text === "crate") {
      return {
        group: 0,
        label: "extern crate",
        mode: "semicolon",
        nestedModule: false,
        traitBody: false,
      };
    }
    if (functionAfterQualifier(tokens, cursor, limit)) {
      return {
        group: 6,
        label: "function",
        mode: "either",
        nestedModule: false,
        traitBody: false,
      };
    }
    return {
      group: 0,
      label: "foreign module",
      mode: "body",
      nestedModule: false,
      traitBody: false,
    };
  }
  if (first === "use") {
    return { group: 1, label: "use", mode: "semicolon", nestedModule: false, traitBody: false };
  }
  if (first === "global_asm") {
    return {
      group: 3,
      label: "global assembly",
      mode: "semicolon",
      nestedModule: false,
      traitBody: false,
    };
  }
  if (first === "macro_rules" || first === "macro" || macroLike(tokens, cursor, limit)) {
    return { group: 2, label: "macro", mode: "either", nestedModule: false, traitBody: false };
  }
  if (first === "static") {
    return { group: 4, label: "static", mode: "semicolon", nestedModule: false, traitBody: false };
  }
  if (first === "const") {
    if (functionAfterQualifier(tokens, cursor, limit)) {
      return {
        group: 6,
        label: "function",
        mode: "either",
        nestedModule: false,
        traitBody: false,
      };
    }
    return {
      group: 4,
      label: "constant",
      mode: "semicolon",
      nestedModule: false,
      traitBody: false,
    };
  }
  if (first === "type") {
    return {
      group: 5,
      label: "type alias",
      mode: "semicolon",
      nestedModule: false,
      traitBody: false,
    };
  }
  if (first === "enum" || first === "struct" || first === "union" || first === "impl") {
    return { group: 5, label: first, mode: "either", nestedModule: false, traitBody: false };
  }
  if (first === "trait") {
    return { group: 5, label: "trait", mode: "either", nestedModule: false, traitBody: true };
  }
  if (first === "fn") {
    return { group: 6, label: "function", mode: "either", nestedModule: false, traitBody: false };
  }
  if (first === "async" || first === "unsafe" || first === "default" || first === "auto") {
    let next = cursor;
    while (
      next < limit &&
      ["async", "unsafe", "default", "auto", "const", "extern"].includes(tokens[next]!.text)
    ) {
      next += 1;
    }
    const keyword = tokens[next]?.text;
    if (keyword === "fn") {
      return {
        group: 6,
        label: "function",
        mode: "either",
        nestedModule: false,
        traitBody: false,
      };
    }
    if (keyword === "trait") {
      return { group: 5, label: "trait", mode: "either", nestedModule: false, traitBody: true };
    }
    if (keyword === "impl") {
      return { group: 5, label: "impl", mode: "either", nestedModule: false, traitBody: false };
    }
  }
  return undefined;
}

function scanRustItem(
  tokens: RustToken[],
  start: number,
  limit: number,
  braces: Map<number, number>,
): RustItem | undefined {
  const classification = classifyRustItem(tokens, start, limit);
  if (!classification) return undefined;

  let cursor = start;
  let parens = 0;
  let brackets = 0;
  while (cursor < limit) {
    const text = tokens[cursor]!.text;
    if (text === "(") parens += 1;
    else if (text === ")") parens = Math.max(0, parens - 1);
    else if (text === "[") brackets += 1;
    else if (text === "]") brackets = Math.max(0, brackets - 1);
    else if (text === "{" && parens === 0 && brackets === 0) {
      const close = braces.get(cursor);
      if (close === undefined) return undefined;
      if (classification.mode === "semicolon") {
        cursor = close + 1;
        continue;
      }
      let end = close + 1;
      if (tokens[end]?.text === ";") end += 1;
      return {
        group: classification.group,
        label: classification.label,
        line: tokens[start]!.line,
        end,
        bodyOpen: cursor,
        bodyClose: close,
        nestedModule: classification.nestedModule,
        traitBody: classification.traitBody,
      };
    } else if (text === ";" && parens === 0 && brackets === 0) {
      return {
        group: classification.group,
        label: classification.label,
        line: tokens[start]!.line,
        end: cursor + 1,
        nestedModule: false,
        traitBody: false,
      };
    }
    cursor += 1;
  }
  return undefined;
}

function skipUnknownRustItem(
  tokens: RustToken[],
  start: number,
  limit: number,
  braces: Map<number, number>,
): number {
  let cursor = start;
  let parens = 0;
  let brackets = 0;
  while (cursor < limit) {
    const text = tokens[cursor]!.text;
    if (text === "(") parens += 1;
    else if (text === ")") parens = Math.max(0, parens - 1);
    else if (text === "[") brackets += 1;
    else if (text === "]") brackets = Math.max(0, brackets - 1);
    else if (text === "{" && parens === 0 && brackets === 0) {
      const close = braces.get(cursor);
      if (close === undefined) return cursor + 1;
      let end = close + 1;
      if (tokens[end]?.text === ";") end += 1;
      return end;
    } else if (text === ";" && parens === 0 && brackets === 0) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return Math.min(start + 1, limit);
}

function traitItemKind(
  tokens: RustToken[],
  start: number,
  limit: number,
): { order: number; label: string } | undefined {
  let cursor = skipAttributes(tokens, start, limit);
  cursor = skipVisibility(tokens, cursor, limit);
  if (cursor >= limit) return undefined;
  const first = tokens[cursor]!.text;
  if (first === "const") return { order: 0, label: "associated constant" };
  if (first === "type") return { order: 1, label: "associated type" };
  if (first === "fn" || functionAfterQualifier(tokens, cursor, limit)) {
    return { order: 2, label: "associated function" };
  }
  return undefined;
}

function checkTraitRange(
  tokens: RustToken[],
  start: number,
  end: number,
  braces: Map<number, number>,
  relativePath: string,
  failures: string[],
): void {
  let cursor = start;
  let previous: { order: number; label: string } | undefined;
  while (cursor < end) {
    const itemStart = skipAttributes(tokens, cursor, end);
    if (itemStart >= end) break;
    const cfgTest = isCfgTestItem(tokens, cursor, end);
    const kind = traitItemKind(tokens, cursor, end);
    const item = scanRustItem(tokens, cursor, end, braces);
    if (cfgTest) {
      cursor = item?.end ?? skipUnknownRustItem(tokens, cursor, end, braces);
      continue;
    }
    if (kind && previous && kind.order < previous.order) {
      failures.push(
        `${relativePath}:${tokens[itemStart]!.line}: ${kind.label} must appear before previously declared ${previous.label} in a trait`,
      );
      return;
    }
    if (kind) previous = kind;
    else previous = undefined;
    cursor = item?.end ?? skipUnknownRustItem(tokens, cursor, end, braces);
  }
}

function checkModuleRange(
  tokens: RustToken[],
  start: number,
  end: number,
  braces: Map<number, number>,
  relativePath: string,
  failures: string[],
): void {
  let cursor = start;
  let previous: { group: number; label: string } | undefined;
  while (cursor < end) {
    if (tokens[cursor]?.text === ";" || tokens[cursor]?.text === ",") {
      cursor += 1;
      continue;
    }
    const cfgTest = isCfgTestItem(tokens, cursor, end);
    const item = scanRustItem(tokens, cursor, end, braces);
    if (!item) {
      previous = undefined;
      cursor = skipUnknownRustItem(tokens, cursor, end, braces);
      continue;
    }
    if (cfgTest) {
      cursor = item.end;
      continue;
    }

    if (previous && item.group < previous.group) {
      failures.push(
        `${relativePath}:${item.line}: ${item.label} must appear before previously declared ${previous.label} according to canonical Rust module-group order`,
      );
      return;
    }
    previous = { group: item.group, label: item.label };

    if (item.nestedModule && item.bodyOpen !== undefined && item.bodyClose !== undefined) {
      checkModuleRange(tokens, item.bodyOpen + 1, item.bodyClose, braces, relativePath, failures);
      if (failures.length > 0) return;
    }
    if (item.traitBody && item.bodyOpen !== undefined && item.bodyClose !== undefined) {
      checkTraitRange(tokens, item.bodyOpen + 1, item.bodyClose, braces, relativePath, failures);
      if (failures.length > 0) return;
    }
    cursor = item.end;
  }
}

function rustSourceOrderingFailuresForSource(source: string, relativePath: string): string[] {
  const failures: string[] = [];
  const tokens = tokenizeRust(source);
  const braces = matchingBraces(tokens);
  checkModuleRange(tokens, 0, tokens.length, braces, relativePath, failures);
  return failures;
}

export function rustSourceOrderingFailures(root: string, components: Component[]): string[] {
  const failures: string[] = [];
  const roots = new Set(
    components
      .filter((component) => component.kind === "rust")
      .map((component) => componentRoot(root, component)),
  );
  for (const rustRoot of roots) {
    for (const file of walkFiles(rustRoot, 12).filter(
      (candidate) => extname(candidate) === ".rs",
    )) {
      try {
        if (statSync(file).size > 1_000_000) continue;
        const relativePath = relative(root, file).replaceAll("\\", "/");
        failures.push(
          ...rustSourceOrderingFailuresForSource(readFileSync(file, "utf8"), relativePath),
        );
      } catch {
        // rustc remains authoritative for invalid or unreadable Rust source.
      }
    }
  }
  return failures;
}

export function rustSourceOrderingOutcome(
  root: string,
  components: Component[],
): RustSourceOrderingOutcome {
  const failures = rustSourceOrderingFailures(root, components);
  return failures.length === 0
    ? { status: "passed" }
    : { status: "failed", stderr: failures.join("\n") };
}
